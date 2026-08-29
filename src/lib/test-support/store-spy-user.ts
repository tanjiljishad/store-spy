import type { PrismaClient, Role } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { PlanTier } from "../entitlements/plan-limits";
import { provisionStoreSpyAccount, syncControlPlanePlan, trialEndsFromNow } from "../control-plane/provision";

/**
 * Integration-test fixture: create a Store Spy user exactly the way the signup
 * route / OAuth adapter now do — a `control_plane` account (+ users +
 * subscriptions + entitlements) plus the two product-specific companion rows
 * (`store_spy.UserAdminRole` when the role is non-USER, `store_spy.Marketing-
 * Consent` always). B2 2·B commit 4: NO shadow `store_spy.User` row — that
 * table has no readers left (see the discharge in docs/store-spy-control-
 * plane-b2.md) and is dropped in step 4.
 *
 * Returns an echo of the resolved inputs — the same values written to the
 * control plane — so fixtures can read `.id` / `.email` / `.plan` / `.role`
 * without a round trip. It is NOT a Prisma row.
 */
export interface StoreSpyTestUser {
  id: string;
  email: string;
  plan: PlanTier;
  role: Role;
  name: string | null;
  passwordHash: string | null;
  emailVerified: Date | null;
  tosAcceptedAt: Date | null;
  /** = the account's `subt_` subscription period_end (the derived "freeTrialEndsAt"). */
  freeTrialEndsAt: Date;
  marketingConsent: boolean;
}

export async function makeStoreSpyUser(
  prisma: PrismaClient,
  opts: {
    email?: string;
    passwordHash?: string | null;
    name?: string | null;
    plan?: PlanTier;
    role?: Role;
    emailVerified?: Date | null;
    tosAcceptedAt?: Date | null;
    freeTrialEndsAt?: Date;
    marketingConsent?: boolean;
  } = {},
): Promise<StoreSpyTestUser> {
  const id = randomUUID();
  const email = opts.email ?? `${randomUUID().slice(0, 12)}@test.local`;
  const plan = opts.plan ?? "FREE";
  const role = opts.role ?? "USER";
  const passwordHash = opts.passwordHash === undefined ? "test-hash" : opts.passwordHash;
  // control_plane.users.tosAcceptedAt has no @default — a bare provision leaves
  // it null. Tests for the OAuth-shaped "no ToS yet" path rely on that; pass an
  // explicit Date for a consented user.
  const tosAcceptedAt = opts.tosAcceptedAt ?? null;
  const emailVerifiedAt = opts.emailVerified ?? null;
  const trialEndsAt = opts.freeTrialEndsAt ?? trialEndsFromNow();
  const marketingConsent = opts.marketingConsent ?? false;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await provisionStoreSpyAccount(tx, { userId: id, email, passwordHash, name: opts.name ?? null, emailVerifiedAt, tosAcceptedAt, trialEndsAt });
    await tx.marketingConsent.create({
      data: marketingConsent ? { userId: id, consent: true, consentAt: now, consentSource: "test" } : { userId: id, consent: false },
    });
    if (role !== "USER") await tx.userAdminRole.create({ data: { userId: id, role } });
    if (plan !== "FREE") await syncControlPlanePlan(tx, { userId: id, plan, trialEndsAt, paidPeriodEnd: null });
  });

  return { id, email, plan, role, name: opts.name ?? null, passwordHash, emailVerified: emailVerifiedAt, tosAcceptedAt, freeTrialEndsAt: trialEndsAt, marketingConsent };
}

/**
 * Set a FREE user's monitoring-trial end to `at` (past OR future) by writing
 * the `subt_` TRIALING subscription's `period_end` — the single source of
 * truth the gate (resolveEntitlement) and the per-watch expiry ceiling
 * (watch.ts) both read.
 */
export async function setTrialWindow(prisma: PrismaClient, userId: string, at: Date): Promise<void> {
  await prisma.cpSubscription.updateMany({ where: { id: `subt_${userId}` }, data: { periodEnd: at } });
}

/**
 * TRUNCATE the control-plane tables + the two companion `store_spy` tables. Call
 * from `beforeEach`. Truncating `control_plane."accounts"` CASCADEs to users /
 * subscriptions / entitlements and, through the migration-20260828180000 FKs
 * (ON DELETE CASCADE, but not ON TRUNCATE — hence the explicit list), does not
 * itself clear the store_spy children; a suite still names `Watchlist`,
 * `AnalysisUsage`, `Session`, `Account`, etc. in its own TRUNCATE.
 */
export async function resetControlPlane(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "control_plane"."accounts","store_spy"."UserAdminRole","store_spy"."MarketingConsent" RESTART IDENTITY CASCADE`,
  );
}
