import type { PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";
import { listPriceCents, type BillingPeriod } from "./pricing";
import { evaluatePromo, redeemPromo } from "./promo";
import { recordAdminAction } from "../admin/audit";
import { clearTrialCeiling } from "./subscription-sweep";
import { syncControlPlanePlan } from "../control-plane/provision";

/**
 * There is no payment provider in this repo today — see
 * docs/milestone-10-subphase-b-billing-and-freemium-decision-report.md.
 * Everything in this module works fully, end to end, for the
 * zero-provider (100%-off promo) path; the `finalCents > 0` path creates a
 * PENDING Checkout and stops at the seam below.
 */
export class NotImplementedError extends Error {}

// PROVIDER SEAM: real payment-provider session creation (Polar/Paddle/etc.,
// per the decision report's recommendation) goes here once a provider is
// chosen. Until then, any finalCents > 0 checkout stays PENDING forever
// (swept after 1 hour — see expirePendingCheckouts() below) rather than
// silently completing.
export function createProviderSession(): never {
  throw new NotImplementedError("No payment provider is configured yet — see the PROVIDER SEAM comment in checkout.ts.");
}

export interface CheckoutRequest {
  userId: string;
  plan: PlanTier;
  period: BillingPeriod;
  code?: string | null;
}

export type CheckoutOutcome =
  | { outcome: "completed_free"; plan: PlanTier }
  | { outcome: "pending"; checkoutId: string; finalCents: number }
  | { outcome: "invalid_promo" }
  | { outcome: "plan_not_purchasable" };

/**
 * The client NEVER sends a price — only `{ plan, period, code? }`. Every
 * cent here is computed server-side from pricing.ts and, if a code was
 * supplied, evaluatePromo(). A supplied code that fails validation rejects
 * the whole checkout rather than silently falling back to full price — a
 * user who typed a bad code should see that, not get charged more than
 * they expected.
 */
export async function processCheckout(prisma: PrismaClient, req: CheckoutRequest): Promise<CheckoutOutcome> {
  if (req.plan === "FREE") return { outcome: "plan_not_purchasable" };

  const listPrice = listPriceCents(req.plan, req.period);
  let discountCents = 0;
  let promoId: string | null = null;

  if (req.code) {
    const evaluation = await evaluatePromo(prisma, { code: req.code, userId: req.userId, plan: req.plan, period: req.period });
    if (!evaluation.ok) return { outcome: "invalid_promo" };
    discountCents = evaluation.discountCents;
    promoId = evaluation.promoId;
  }

  const finalCents = listPrice - discountCents;

  if (finalCents === 0) {
    const plan = req.plan;
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: req.userId }, select: { email: true } });

      const checkout = await tx.checkout.create({
        data: {
          userId: req.userId,
          plan,
          period: req.period,
          promoCodeId: promoId,
          listPriceCents: listPrice,
          discountCents,
          finalCents: 0,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });

      if (promoId) {
        await redeemPromo(tx, {
          promoId,
          userId: req.userId,
          checkoutId: checkout.id,
          amounts: { listPriceCents: listPrice, discountCents, finalCents: 0 },
        });
      }

      // TRANSITIONAL (B2 step 2·B): the User.plan write. B2 step 2·A keeps it
      // alongside the control-plane write below (syncControlPlanePlan); 2·B
      // drops this line and lets the control plane be the sole source of plan.
      await tx.user.update({ where: { id: req.userId }, data: { plan } });
      // Milestone 12 §1.4: lifts any FREE-trial expiry ceiling from the
      // user's existing watches now that they've actually paid (or redeemed
      // a 100%-off promo) for a plan that carries none.
      await clearTrialCeiling(tx, req.userId);

      // The Subscription's expiry follows the redeemed promo's own
      // durationDays (Milestone 11 Phase 3 §3.4 amendment) — null means
      // perpetual, an explicit admin choice, never a default.
      let expiresAt: Date | null = null;
      if (promoId) {
        const promo = await tx.promoCode.findUniqueOrThrow({ where: { id: promoId }, select: { durationDays: true } });
        expiresAt = promo.durationDays === null ? null : new Date(Date.now() + promo.durationDays * 24 * 60 * 60 * 1000);
      }
      await tx.subscription.create({
        data: { userId: req.userId, plan, source: "PROMO", status: "ACTIVE", expiresAt },
      });

      // B2 step 2·A dual-write: mirror the plan into the control plane. Same
      // expiry the store_spy.Subscription just got. `verify:b2-step1` is the
      // gate that this stays in sync — see docs/store-spy-control-plane-b2.md.
      await syncControlPlanePlan(tx, { userId: req.userId, plan, trialEndsAt: null, paidPeriodEnd: expiresAt });

      await recordAdminAction(tx, {
        actorId: req.userId,
        actorEmail: user.email,
        action: "checkout.completed_free",
        targetType: "User",
        targetId: req.userId,
        metadata: { checkoutId: checkout.id, plan, promoId },
      });
    });

    return { outcome: "completed_free", plan };
  }

  // finalCents > 0: create a PENDING checkout and stop here. The promo is
  // deliberately NOT redeemed yet — redemption happens only when payment
  // confirms (at the provider seam), or a failed card burns nothing.
  const checkout = await prisma.checkout.create({
    data: {
      userId: req.userId,
      plan: req.plan,
      period: req.period,
      promoCodeId: promoId,
      listPriceCents: listPrice,
      discountCents,
      finalCents,
      status: "PENDING",
    },
  });

  return { outcome: "pending", checkoutId: checkout.id, finalCents };
}

const PENDING_CHECKOUT_MAX_AGE_MS = 60 * 60_000;

/** Run from the worker tick, next to the other sweeps. Purely a status flip — a PENDING checkout never redeemed a promo, so there's nothing to roll back. */
export async function expirePendingCheckouts(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<{ expiredCount: number }> {
  const cutoff = new Date(now.getTime() - PENDING_CHECKOUT_MAX_AGE_MS);
  const result = await prisma.checkout.updateMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
    data: { status: "EXPIRED" },
  });
  return { expiredCount: result.count };
}
