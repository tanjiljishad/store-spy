import type { PrismaClient } from "@prisma/client";
import type { PlanTier } from "../../entitlements/plan-limits";
import type { SubscriptionSource } from "@prisma/client";
import { monthlyPriceCents } from "../../billing/pricing";
import { utcParam } from "./window";

/**
 * Milestone 12 §3.1: "MRR, new/expansion/churned MRR, ARPU, active
 * subscriptions by plan, promo-granted vs paid subscriptions."
 *
 * Price policy stays entirely in billing/pricing.ts — every query here
 * returns plan-grouped RAW COUNTS, never a dollar figure computed in SQL.
 * pricing.ts is the one place a price can change; duplicating
 * MONTHLY_PRICE_CENTS into a raw SQL CASE expression would create a second
 * copy that could silently drift from it.
 *
 * Definitions used below (none of these are specified verbatim by the doc,
 * so they're recorded here rather than left implicit):
 *   - MRR (point-in-time, "as of windowEnd"): sum of monthlyPriceCents(plan)
 *     over subscriptions ACTIVE at windowEnd (started <= windowEnd, and
 *     either no expiry or expiry after windowEnd).
 *   - New MRR: subscriptions STARTING inside the window that are the
 *     user's first-ever Subscription row (first-time payer).
 *   - Expansion / contraction MRR: subscriptions starting inside the
 *     window where the user already had an earlier Subscription — the
 *     price delta vs. their immediately-preceding plan is positive
 *     (expansion) or negative (contraction, downgrade-while-still-paying;
 *     not asked for by the doc but falls out of the same query, and
 *     silently dropping real downgrade revenue impact would be worse than
 *     reporting it as its own line).
 *   - Churned MRR: subscriptions whose status flipped to EXPIRED with an
 *     expiresAt inside the window (expireDueSubscriptions() runs on the
 *     5-minute worker tick, so expiresAt is a faithful proxy for "when
 *     this stopped paying," not exact-to-the-second).
 *   - ARPU: MRR at windowEnd / COUNT(DISTINCT userId) of ACTIVE
 *     subscriptions at windowEnd — DISTINCT because checkout.ts does not
 *     prevent a user from accumulating more than one ACTIVE Subscription
 *     row (no such invariant exists in the schema today), so COUNT(*)
 *     would overcount paying users if that ever happens.
 */

export interface PlanSourceCount {
  plan: PlanTier;
  source: SubscriptionSource;
  count: number;
}

export interface RevenueMetrics {
  windowStart: Date;
  windowEnd: Date;
  mrrCentsByPlan: Record<PlanTier, number>;
  mrrCentsTotal: number;
  activeSubscriptionsByPlan: Record<PlanTier, number>;
  activeSubscriptionsBySource: Partial<Record<SubscriptionSource, number>>;
  activePayingUserCount: number;
  arpuCents: number | null;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnedMrrCents: number;
}

const ZERO_BY_PLAN = (): Record<PlanTier, number> => ({ FREE: 0, BASIC: 0, BUSINESS: 0 });

export async function getRevenueMetrics(prisma: PrismaClient, windowStart: Date, windowEnd: Date): Promise<RevenueMetrics> {
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);

  const [activeByPlanSource, distinctActive, newRows, expansionRows, churnedRows] = await Promise.all([
    prisma.$queryRaw<{ plan: PlanTier; source: SubscriptionSource; n: number }[]>`
      SELECT plan, source, COUNT(*)::int AS n
      FROM "Subscription"
      WHERE status = 'ACTIVE' AND "startedAt" <= ${end} AND ("expiresAt" IS NULL OR "expiresAt" > ${end})
      GROUP BY plan, source
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT "userId")::int AS n
      FROM "Subscription"
      WHERE status = 'ACTIVE' AND "startedAt" <= ${end} AND ("expiresAt" IS NULL OR "expiresAt" > ${end})
    `,
    // First-ever Subscription row per user, starting inside the window.
    prisma.$queryRaw<{ plan: PlanTier; n: number }[]>`
      SELECT s.plan, COUNT(*)::int AS n
      FROM "Subscription" s
      WHERE s."startedAt" >= ${start} AND s."startedAt" < ${end}
        AND NOT EXISTS (SELECT 1 FROM "Subscription" s2 WHERE s2."userId" = s."userId" AND s2."startedAt" < s."startedAt")
      GROUP BY s.plan
    `,
    // Subscriptions starting inside the window where the user already had
    // an earlier row — paired with that immediately-preceding plan so the
    // price delta (expansion vs. contraction) can be computed in TS.
    prisma.$queryRaw<{ new_plan: PlanTier; prev_plan: PlanTier; n: number }[]>`
      SELECT s.plan AS new_plan, prev.plan AS prev_plan, COUNT(*)::int AS n
      FROM "Subscription" s
      JOIN LATERAL (
        SELECT plan FROM "Subscription" s2
        WHERE s2."userId" = s."userId" AND s2."startedAt" < s."startedAt"
        ORDER BY s2."startedAt" DESC LIMIT 1
      ) prev ON true
      WHERE s."startedAt" >= ${start} AND s."startedAt" < ${end}
      GROUP BY s.plan, prev.plan
    `,
    prisma.$queryRaw<{ plan: PlanTier; n: number }[]>`
      SELECT plan, COUNT(*)::int AS n
      FROM "Subscription"
      WHERE status = 'EXPIRED' AND "expiresAt" >= ${start} AND "expiresAt" < ${end}
      GROUP BY plan
    `,
  ]);

  const mrrCentsByPlan = ZERO_BY_PLAN();
  const activeSubscriptionsByPlan = ZERO_BY_PLAN();
  const activeSubscriptionsBySource: Partial<Record<SubscriptionSource, number>> = {};
  for (const row of activeByPlanSource) {
    mrrCentsByPlan[row.plan] += monthlyPriceCents(row.plan) * row.n;
    activeSubscriptionsByPlan[row.plan] += row.n;
    activeSubscriptionsBySource[row.source] = (activeSubscriptionsBySource[row.source] ?? 0) + row.n;
  }
  const mrrCentsTotal = mrrCentsByPlan.FREE + mrrCentsByPlan.BASIC + mrrCentsByPlan.BUSINESS;

  const newMrrCents = newRows.reduce((sum, r) => sum + monthlyPriceCents(r.plan) * r.n, 0);

  let expansionMrrCents = 0;
  let contractionMrrCents = 0;
  for (const r of expansionRows) {
    const delta = (monthlyPriceCents(r.new_plan) - monthlyPriceCents(r.prev_plan)) * r.n;
    if (delta > 0) expansionMrrCents += delta;
    else if (delta < 0) contractionMrrCents += -delta;
    // delta === 0 (re-subscribing to the same plan) contributes to neither.
  }

  const churnedMrrCents = churnedRows.reduce((sum, r) => sum + monthlyPriceCents(r.plan) * r.n, 0);

  const activePayingUserCount = distinctActive[0].n;
  const arpuCents = activePayingUserCount === 0 ? null : mrrCentsTotal / activePayingUserCount;

  return {
    windowStart,
    windowEnd,
    mrrCentsByPlan,
    mrrCentsTotal,
    activeSubscriptionsByPlan,
    activeSubscriptionsBySource,
    activePayingUserCount,
    arpuCents,
    newMrrCents,
    expansionMrrCents,
    contractionMrrCents,
    churnedMrrCents,
  };
}
