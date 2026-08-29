import type { PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";

/**
 * Control-plane account provisioning — the write side of the B2 step 1
 * backfill, as a runtime function.
 *
 * `provisionStoreSpyAccount()` is called for every brand-new Store Spy user
 * (the signup route and the OAuth adapter's createUser). `syncControlPlanePlan()`
 * rebuilds an existing account's `store-spy` subscriptions + entitlements from
 * a plan value — called by checkout, the subscription sweep, and admin
 * setUserPlan. As of B2 2·B commit 3b the control plane is the SOLE store of
 * plan; there is no `store_spy.User.plan` write alongside these any more.
 *
 * Account id is `acct_<userId>` — same convention the step 1 backfill used, so
 * a caller with only a userId can address the account without a lookup.
 */

export const STORE_SPY_PRODUCT_ID = "prod_store_spy"; // seeded by migration 20260828120000
export const FREE_TRIAL_DAYS = 30;

/** The Milestone 12 plan matrix, in one place. Mirrors what migration 20260828170000 hard-codes. */
export const PLAN_ENTITLEMENTS: Record<PlanTier, { analysisRun: number; monitoringSlots: number; intelligenceAdvanced: boolean }> = {
  FREE: { analysisRun: 10, monitoringSlots: 1, intelligenceAdvanced: false },
  BASIC: { analysisRun: 50, monitoringSlots: 20, intelligenceAdvanced: true },
  BUSINESS: { analysisRun: 100, monitoringSlots: 50, intelligenceAdvanced: true },
};

export function trialEndsFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

type CpTx = Pick<PrismaClient, "cpAccount" | "cpUser" | "cpSubscription" | "cpEntitlement">;

/**
 * The monitoring-trial end for an account: its current TRIALING subscription's
 * `period_end`, or — for an account that has none right now (a paid one being
 * downgraded) — `cpUser.createdAt + 30d`, the same value the old
 * `store_spy.User.freeTrialEndsAt` DB default produced. Callers read this
 * BEFORE syncControlPlanePlan() deletes and rebuilds the subscriptions.
 */
export async function resolveTrialEnd(tx: CpTx, userId: string): Promise<Date> {
  const [subt, user] = await Promise.all([
    tx.cpSubscription.findUnique({ where: { id: `subt_${userId}` }, select: { periodEnd: true } }),
    tx.cpUser.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
  ]);
  return subt?.periodEnd ?? new Date(user.createdAt.getTime() + FREE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Write an account's `store-spy` subscriptions + entitlements from a plan.
 *   FREE -> subf_ (ACTIVE, perpetual) grants analysis.run
 *        +  subt_ (TRIALING, period_end = trialEndsAt) grants monitoring.slots
 *   paid -> one sub_ (ACTIVE, period_end = paidPeriodEnd) grants all three
 * See CpSubscription's doc comment for why FREE is two rows.
 */
async function writeStoreSpySubscriptions(
  tx: CpTx,
  args: { accountId: string; userId: string; plan: PlanTier; trialEndsAt: Date | null; paidPeriodEnd: Date | null },
): Promise<void> {
  const ent = PLAN_ENTITLEMENTS[args.plan];

  if (args.plan === "FREE") {
    await tx.cpSubscription.create({
      data: { id: `subf_${args.userId}`, accountId: args.accountId, productId: STORE_SPY_PRODUCT_ID, status: "ACTIVE", planSlug: "FREE", periodEnd: null },
    });
    await tx.cpSubscription.create({
      data: {
        id: `subt_${args.userId}`,
        accountId: args.accountId,
        productId: STORE_SPY_PRODUCT_ID,
        status: "TRIALING",
        planSlug: "FREE",
        periodEnd: args.trialEndsAt ?? trialEndsFromNow(),
      },
    });
    await tx.cpEntitlement.createMany({
      data: [
        { id: `entf_${args.userId}_arun`, subscriptionId: `subf_${args.userId}`, featureKey: "store_spy.analysis.run", quota: ent.analysisRun },
        { id: `entt_${args.userId}_mslots`, subscriptionId: `subt_${args.userId}`, featureKey: "store_spy.monitoring.slots", quota: ent.monitoringSlots },
      ],
    });
    return;
  }

  await tx.cpSubscription.create({
    data: { id: `sub_${args.userId}`, accountId: args.accountId, productId: STORE_SPY_PRODUCT_ID, status: "ACTIVE", planSlug: args.plan, periodEnd: args.paidPeriodEnd },
  });
  await tx.cpEntitlement.createMany({
    data: [
      { id: `ent_${args.userId}_arun`, subscriptionId: `sub_${args.userId}`, featureKey: "store_spy.analysis.run", quota: ent.analysisRun },
      { id: `ent_${args.userId}_mslots`, subscriptionId: `sub_${args.userId}`, featureKey: "store_spy.monitoring.slots", quota: ent.monitoringSlots },
      { id: `ent_${args.userId}_iadv`, subscriptionId: `sub_${args.userId}`, featureKey: "store_spy.intelligence.advanced", quota: null },
    ],
  });
}

/** Provision the control-plane account for a new Store Spy user. Always starts on FREE (two-subscription shape). */
export async function provisionStoreSpyAccount(
  tx: CpTx,
  args: {
    userId: string;
    email: string;
    passwordHash: string | null;
    name: string | null;
    image?: string | null;
    emailVerifiedAt: Date | null;
    tosAcceptedAt: Date | null;
    trialEndsAt: Date;
  },
): Promise<{ accountId: string }> {
  const accountId = `acct_${args.userId}`;
  await tx.cpAccount.create({ data: { id: accountId, billingEmail: args.email } });
  await tx.cpUser.create({
    data: {
      id: args.userId,
      accountId,
      email: args.email,
      passwordHash: args.passwordHash,
      name: args.name,
      image: args.image ?? null,
      emailVerifiedAt: args.emailVerifiedAt,
      tosAcceptedAt: args.tosAcceptedAt,
    },
  });
  await writeStoreSpySubscriptions(tx, { accountId, userId: args.userId, plan: "FREE", trialEndsAt: args.trialEndsAt, paidPeriodEnd: null });
  return { accountId };
}

/**
 * Rebuild an existing account's `store-spy` subscriptions + entitlements to
 * match `plan`. Idempotent (deterministic ids, delete-then-recreate). The
 * `store-spy` subscriptions are dropped and rewritten; other products (none
 * today) are untouched.
 *
 * `trialEndsAt` is only read for `plan === "FREE"` — pass `resolveTrialEnd()`
 * on a downgrade so a returning FREE user's trial window is unchanged (usually
 * already past). `paidPeriodEnd` is only read for a paid plan (null =
 * perpetual, e.g. an admin-set plan or a perpetual promo).
 */
export async function syncControlPlanePlan(
  tx: CpTx,
  args: { userId: string; plan: PlanTier; trialEndsAt: Date | null; paidPeriodEnd: Date | null },
): Promise<void> {
  const accountId = `acct_${args.userId}`;
  // entitlements cascade on subscription delete (entitlements_subscription_id_fkey ON DELETE CASCADE).
  await tx.cpSubscription.deleteMany({ where: { accountId, productId: STORE_SPY_PRODUCT_ID } });
  await writeStoreSpySubscriptions(tx, { accountId, userId: args.userId, plan: args.plan, trialEndsAt: args.trialEndsAt, paidPeriodEnd: args.paidPeriodEnd });
}
