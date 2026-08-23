import type { PlanTier } from "../entitlements/plan-limits";

/**
 * Server-side price table. Prisma-free — same convention as plan-limits.ts.
 * Integer cents only, matching money.ts's own convention throughout this
 * codebase: never a float near a price.
 *
 * The client NEVER sends a price. It sends `{ plan, period, code? }` and
 * the server returns the computed total (see billing/checkout.ts) — any
 * design where the browser supplies an amount is a vulnerability, not a
 * shortcut.
 *
 * These are PLACEHOLDER numbers, not a finalized decision — per
 * docs/milestone-10-subphase-b-billing-and-freemium-decision-report.md
 * §29/§35: "$19/month (test range $15–$25)" is a recommendation, not an
 * adopted price. Sub-phase C's own scope explicitly excluded finalizing
 * billing ("no provider selected... no billing fields... added"). Update
 * this file, not the fallback logic around it, once a real number is
 * chosen.
 */
export type BillingPeriod = "MONTHLY" | "ANNUAL";

/**
 * Milestone 12 D4: BASIC and BUSINESS are no longer billed identically.
 * BASIC's $19/mo stays the same unfinalized placeholder it always was
 * (D4 explicitly deferred it this phase — leave it untouched). BUSINESS's
 * $49/mo is a confirmed, real number (D4), matching plan-limits.ts's own
 * un-collapsing of the two tiers' entitlements (20 vs. 50 monitored
 * stores, 50 vs. 100 analyses/24h) — they stopped being the same offer
 * with two enum spellings.
 *
 * ANNUAL is priced at 12x monthly with NO discount applied — the decision
 * report explicitly lists "Annual billing" under "What Not to Build" for
 * V1 (§30). The BillingPeriod type still needs both values structurally
 * (§3.1 of this milestone's own spec requires it), so ANNUAL exists here
 * as a non-discounted, unmarketed multiple rather than a real second price
 * point invented without product backing — flag this explicitly for
 * confirmation before ANNUAL is ever surfaced as a real, chosen option in
 * any UI.
 */
const MONTHLY_PRICE_CENTS: Record<PlanTier, number> = {
  FREE: 0,
  BASIC: 1900, // $19.00 — still an unfinalized placeholder, see the doc comment above
  BUSINESS: 4900, // $49.00 — confirmed (Milestone 12 D4), not a placeholder
};

export function listPriceCents(plan: PlanTier, period: BillingPeriod): number {
  if (plan === "FREE") return 0;
  const monthly = MONTHLY_PRICE_CENTS[plan];
  return period === "ANNUAL" ? monthly * 12 : monthly;
}

/**
 * Milestone 12 §3.1: the admin revenue metrics (MRR, ARPU, new/expansion/
 * churned MRR — see admin/analytics/revenue.ts) need a plain monthly price
 * per plan, not a period-adjusted total. Reuses listPriceCents() rather
 * than re-reading MONTHLY_PRICE_CENTS directly, so this file stays the
 * single source of truth for price even for a caller that only ever cares
 * about the monthly figure.
 */
export function monthlyPriceCents(plan: PlanTier): number {
  return listPriceCents(plan, "MONTHLY");
}
