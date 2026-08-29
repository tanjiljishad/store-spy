import type { PrismaClient, Role, User } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { PlanTier } from "../entitlements/plan-limits";
import { provisionStoreSpyAccount, syncControlPlanePlan, trialEndsFromNow } from "../control-plane/provision";

/**
 * Integration-test fixture: create a Store Spy user the way B2 step 2·A's
 * signup / OAuth-adapter path does — a `control_plane` account (+ users +
 * subscriptions + entitlements) AND a transitional shadow `store_spy.User`
 * row (+ its `UserAdminRole` / `MarketingConsent` companions).
 *
 * Tests that only touch code still reading `User.plan` (most of them) can keep
 * `prisma.user.create` directly; this is for the ones that exercise a path
 * which now dual-writes the control plane (checkout, subscription sweep, admin
 * setUserPlan/updateUserRole, account delete, signup, consent).
 */
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
): Promise<User> {
  const id = randomUUID();
  const email = opts.email ?? `${randomUUID().slice(0, 12)}@test.local`;
  const plan = opts.plan ?? "FREE";
  const role = opts.role ?? "USER";
  const passwordHash = opts.passwordHash === undefined ? "test-hash" : opts.passwordHash;
  // Mirror `prisma.user.create` defaults: store_spy.User.tosAcceptedAt has no
  // @default, so a bare create leaves it null. Tests for the OAuth-shaped
  // "no ToS yet" path rely on that. Pass an explicit Date for a consented user.
  const tosAcceptedAt = opts.tosAcceptedAt ?? null;
  const emailVerifiedAt = opts.emailVerified ?? null;
  const trialEndsAt = opts.freeTrialEndsAt ?? trialEndsFromNow();
  const marketingConsent = opts.marketingConsent ?? false;
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await provisionStoreSpyAccount(tx, { userId: id, email, passwordHash, name: opts.name ?? null, emailVerifiedAt, tosAcceptedAt, trialEndsAt });
    const user = await tx.user.create({
      data: {
        id,
        email,
        passwordHash,
        name: opts.name ?? null,
        emailVerified: emailVerifiedAt,
        tosAcceptedAt,
        freeTrialEndsAt: trialEndsAt,
        plan,
        role,
        ...(marketingConsent ? { marketingConsent: true, marketingConsentAt: now, marketingConsentSource: "test" } : {}),
      },
    });
    await tx.marketingConsent.create({
      data: marketingConsent ? { userId: id, consent: true, consentAt: now, consentSource: "test" } : { userId: id, consent: false },
    });
    if (role !== "USER") await tx.userAdminRole.create({ data: { userId: id, role } });
    if (plan !== "FREE") await syncControlPlanePlan(tx, { userId: id, plan, trialEndsAt, paidPeriodEnd: null });
    return user;
  });
}

/**
 * TRUNCATE the control-plane tables + the two step-1 store_spy tables. Call
 * from `beforeEach` alongside the suite's existing `TRUNCATE "User" ...` —
 * `control_plane.*` has no FK to `store_spy.User`, and `UserAdminRole` /
 * `MarketingConsent` have none until migration 20260828180000, so a plain
 * `TRUNCATE "User" CASCADE` does not reach them.
 */
/**
 * Set a FREE user's monitoring-trial end to `at` (past OR future), writing
 * BOTH the `subt_` TRIALING subscription's `period_end` — the source of
 * truth the gate (resolveEntitlement) and the per-watch expiry ceiling
 * (watch.ts) both read as of B2 2·B commit 3a — AND the legacy shadow
 * `store_spy.User.freeTrialEndsAt`, so a fixture that still reads the shadow
 * column sees the same value. Once step 4 drops the column the second write
 * goes away.
 */
export async function setTrialWindow(prisma: PrismaClient, userId: string, at: Date): Promise<void> {
  await prisma.cpSubscription.updateMany({ where: { id: `subt_${userId}` }, data: { periodEnd: at } });
  await prisma.user.update({ where: { id: userId }, data: { freeTrialEndsAt: at } });
}

export async function resetControlPlane(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "control_plane"."accounts","store_spy"."UserAdminRole","store_spy"."MarketingConsent" RESTART IDENTITY CASCADE`,
  );
}
