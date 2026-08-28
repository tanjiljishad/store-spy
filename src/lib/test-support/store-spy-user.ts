import type { PrismaClient, Role } from "@prisma/client";
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
): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = opts.email ?? `${randomUUID().slice(0, 12)}@test.local`;
  const plan = opts.plan ?? "FREE";
  const role = opts.role ?? "USER";
  const passwordHash = opts.passwordHash === undefined ? "test-hash" : opts.passwordHash;
  const tosAcceptedAt = opts.tosAcceptedAt === undefined ? new Date() : opts.tosAcceptedAt;
  const emailVerifiedAt = opts.emailVerified ?? null;
  const trialEndsAt = opts.freeTrialEndsAt ?? trialEndsFromNow();
  const marketingConsent = opts.marketingConsent ?? false;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await provisionStoreSpyAccount(tx, { userId: id, email, passwordHash, name: opts.name ?? null, emailVerifiedAt, tosAcceptedAt, trialEndsAt });
    await tx.user.create({
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
  });

  return { id, email };
}

/**
 * TRUNCATE the control-plane tables + the two step-1 store_spy tables. Call
 * from `beforeEach` alongside the suite's existing `TRUNCATE "User" ...` —
 * `control_plane.*` has no FK to `store_spy.User`, and `UserAdminRole` /
 * `MarketingConsent` have none until migration 20260828180000, so a plain
 * `TRUNCATE "User" CASCADE` does not reach them.
 */
export async function resetControlPlane(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "control_plane"."accounts","store_spy"."UserAdminRole","store_spy"."MarketingConsent" RESTART IDENTITY CASCADE`,
  );
}
