import { Prisma, type PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";
import { listPriceCents, type BillingPeriod } from "./pricing";
import { normalizePromoCode } from "./promo-code";

/**
 * Two separate functions, deliberately — this distinction is the whole
 * design. evaluatePromo() is read-only and safe to call from a preview
 * endpoint; it NEVER writes. redeemPromo() is the only place a
 * PromoRedemption row is ever written, always inside the CALLER's own
 * transaction (never its own — see checkout.ts, which pairs it with the
 * plan upgrade and Checkout status write atomically).
 */

export type PromoEvaluationFailureReason =
  | "not_found"
  | "expired"
  | "not_yet_valid"
  | "disabled"
  | "exhausted"
  | "already_redeemed"
  | "not_assigned_to_you"
  | "wrong_plan";

export type PromoEvaluation =
  | { ok: true; promoId: string; listPriceCents: number; discountCents: number; finalCents: number }
  | { ok: false; reason: PromoEvaluationFailureReason };

export interface EvaluatePromoArgs {
  code: string;
  userId: string;
  plan: PlanTier;
  period: BillingPeriod;
}

/**
 * Read-only. Every failure reason is real and distinct, but the ROUTE layer
 * must collapse `not_assigned_to_you` to look identical to `not_found` —
 * see checkout.ts — so this function's own reason is never surfaced to the
 * browser verbatim; it exists for server-side branching and logging only.
 */
export async function evaluatePromo(prisma: PrismaClient, args: EvaluatePromoArgs): Promise<PromoEvaluation> {
  const normalized = normalizePromoCode(args.code);
  const promo = await prisma.promoCode.findUnique({ where: { code: normalized } });
  if (!promo) return { ok: false, reason: "not_found" };

  if (promo.assignedToUserId && promo.assignedToUserId !== args.userId) {
    return { ok: false, reason: "not_assigned_to_you" };
  }
  if (promo.status !== "ACTIVE") return { ok: false, reason: "disabled" };

  const now = new Date();
  if (now < promo.validFrom) return { ok: false, reason: "not_yet_valid" };
  if (promo.validUntil && now > promo.validUntil) return { ok: false, reason: "expired" };

  if (promo.appliesToPlan && promo.appliesToPlan !== args.plan) return { ok: false, reason: "wrong_plan" };

  if (promo.maxRedemptions !== null) {
    const totalRedemptions = await prisma.promoRedemption.count({ where: { promoCodeId: promo.id } });
    if (totalRedemptions >= promo.maxRedemptions) return { ok: false, reason: "exhausted" };
  }

  const userRedemptions = await prisma.promoRedemption.count({ where: { promoCodeId: promo.id, userId: args.userId } });
  if (userRedemptions >= promo.perUserLimit) return { ok: false, reason: "already_redeemed" };

  const price = listPriceCents(args.plan, args.period);
  const rawDiscount = promo.discountType === "PERCENT" ? Math.floor((price * promo.discountValue) / 100) : promo.discountValue;
  // Clamp: a fixed-amount promo larger than the list price can never
  // produce a negative total (or, worse, a refund).
  const discountCents = Math.min(rawDiscount, price);
  const finalCents = price - discountCents;

  return { ok: true, promoId: promo.id, listPriceCents: price, discountCents, finalCents };
}

export type RedeemPromoFailureReason = "exhausted" | "already_redeemed" | "promo_not_found";

/** Thrown by redeemPromo() — the caller's transaction rolls back automatically on any throw. */
export class PromoRedemptionError extends Error {
  constructor(public reason: RedeemPromoFailureReason) {
    super(`Promo redemption failed: ${reason}`);
    this.name = "PromoRedemptionError";
  }
}

export interface RedeemPromoArgs {
  promoId: string;
  userId: string;
  checkoutId: string | null;
  amounts: { listPriceCents: number; discountCents: number; finalCents: number };
}

/**
 * The ONLY place a PromoRedemption row is ever written. Atomic via the same
 * pattern recordAnalysisUsage() uses: pg_advisory_xact_lock on a fixed key
 * derived from the promo id serializes every concurrent redemption attempt
 * for THIS promo (different promos never block each other), so the
 * count-then-insert below can never race — two simultaneous redemptions of
 * a maxRedemptions: 1 promo cannot both succeed. The (promoCodeId, userId)
 * unique index is a second, independent backstop at the database level
 * specifically for perUserLimit — caught below and converted to the same
 * typed error rather than leaking a raw constraint-violation.
 */
export async function redeemPromo(tx: Prisma.TransactionClient, args: RedeemPromoArgs): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('promo:' || ${args.promoId})::bigint)`;

  const promo = await tx.promoCode.findUnique({ where: { id: args.promoId } });
  if (!promo) throw new PromoRedemptionError("promo_not_found");

  if (promo.maxRedemptions !== null) {
    const totalRedemptions = await tx.promoRedemption.count({ where: { promoCodeId: args.promoId } });
    if (totalRedemptions >= promo.maxRedemptions) throw new PromoRedemptionError("exhausted");
  }
  const userRedemptions = await tx.promoRedemption.count({ where: { promoCodeId: args.promoId, userId: args.userId } });
  if (userRedemptions >= promo.perUserLimit) throw new PromoRedemptionError("already_redeemed");

  try {
    await tx.promoRedemption.create({
      data: {
        promoCodeId: args.promoId,
        userId: args.userId,
        checkoutId: args.checkoutId,
        listPriceCents: args.amounts.listPriceCents,
        discountCents: args.amounts.discountCents,
        finalCents: args.amounts.finalCents,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new PromoRedemptionError("already_redeemed");
    }
    throw e;
  }
}
