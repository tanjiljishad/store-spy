import type { PrismaClient } from "@prisma/client";
import type { PlanTier } from "../../entitlements/plan-limits";
import { getDailyTrend, getLatestPointInTimeSnapshot, getLatestSnapshot, getRetentionCohorts } from "./read";
import type { StandardWindow } from "./window";

/**
 * Milestone 12 §3.2: the ONE thing /admin/analytics's Server Component
 * calls. Every field here comes from MetricSnapshot (via read.ts) — never
 * a live aggregate query — so this function is cheap enough to run on
 * every page load even though the numbers it returns were computed by the
 * worker up to an hour ago.
 */

function valueFor(points: { dimension: string; value: number }[], dimension: string): number {
  return points.find((p) => p.dimension === dimension)?.value ?? 0;
}

export interface FunnelStepView {
  key: string;
  label: string;
  count: number;
}

export interface DashboardData {
  window: StandardWindow;
  computedAt: Date | null;
  funnel: FunnelStepView[];
  activation: { signups: number; activatedWithin24h: number; watchedWithin7d: number };
  revenue: {
    mrrCentsByPlan: Record<PlanTier, number>;
    mrrCentsTotal: number;
    arpuCents: number;
    newMrrCents: number;
    expansionMrrCents: number;
    contractionMrrCents: number;
    churnedMrrCents: number;
    activeSubscriptionsByPlan: Record<PlanTier, number>;
    activeSubscriptionsBySource: { source: string; count: number }[];
  };
  usageCost: {
    analysesByPlan: Record<PlanTier, number>;
    crawlVolume: number;
    crawlFailures: number;
    serpApiCalls: number;
    serpApiCostCents: number;
    activeBusinessAccounts: number;
    costPerActiveBusinessAccountCents: number;
    dailyTrend: { day: Date; plan: PlanTier; count: number }[];
  };
  operational: { schedulerLag: number; disabledStores: number; storesOnFailureStreak: number; promoRedemptions: number };
  retention: { cohortMonth: Date; cohortSize: number; everPaid: number; currentlyPaid: number }[];
}

const FUNNEL_STEPS: { key: string; metricKey: string; label: string }[] = [
  { key: "anonymous_analysis", metricKey: "funnel.anonymous_analyses", label: "Anonymous analysis" },
  { key: "signup", metricKey: "funnel.signups", label: "Signup" },
  { key: "first_analysis", metricKey: "funnel.first_analyses", label: "First analysis" },
  { key: "first_watch", metricKey: "funnel.first_watches", label: "First watch" },
  { key: "paid", metricKey: "funnel.paid_conversions", label: "Paid" },
];

export async function getAnalyticsDashboardData(prisma: PrismaClient, window: StandardWindow): Promise<DashboardData> {
  const [
    funnelPoints,
    activationSignups,
    activationActivated,
    activationWatched,
    mrrByPlan,
    mrrTotal,
    arpu,
    newMrr,
    expansionMrr,
    contractionMrr,
    churnedMrr,
    activeSubsByPlan,
    activeSubsBySource,
    analysesByPlan,
    crawlVolume,
    crawlFailures,
    serpApiCalls,
    serpApiCostCents,
    activeBusinessAccounts,
    costPerActiveBusinessAccountCents,
    dailyTrend,
    schedulerLag,
    disabledStores,
    storesOnFailureStreak,
    promoRedemptions,
    retentionCohorts,
  ] = await Promise.all([
    Promise.all(FUNNEL_STEPS.map((s) => getLatestSnapshot(prisma, s.metricKey, window))),
    getLatestSnapshot(prisma, "activation.signups", window),
    getLatestSnapshot(prisma, "activation.activated_24h", window),
    getLatestSnapshot(prisma, "activation.watched_7d", window),
    getLatestSnapshot(prisma, "revenue.mrr_cents", window),
    getLatestSnapshot(prisma, "revenue.mrr_cents_total", window),
    getLatestSnapshot(prisma, "revenue.arpu_cents", window),
    getLatestSnapshot(prisma, "revenue.new_mrr_cents", window),
    getLatestSnapshot(prisma, "revenue.expansion_mrr_cents", window),
    getLatestSnapshot(prisma, "revenue.contraction_mrr_cents", window),
    getLatestSnapshot(prisma, "revenue.churned_mrr_cents", window),
    getLatestSnapshot(prisma, "revenue.active_subscriptions", window),
    getLatestSnapshot(prisma, "revenue.active_subscriptions_by_source", window),
    getLatestSnapshot(prisma, "usage_cost.analyses", window),
    getLatestSnapshot(prisma, "usage_cost.crawl_volume", window),
    getLatestSnapshot(prisma, "usage_cost.crawl_failures", window),
    getLatestSnapshot(prisma, "usage_cost.serpapi_calls", window),
    getLatestSnapshot(prisma, "usage_cost.serpapi_cost_cents", window),
    getLatestSnapshot(prisma, "usage_cost.active_business_accounts", window),
    getLatestSnapshot(prisma, "usage_cost.cost_per_active_business_account_cents", window),
    getDailyTrend(prisma, "usage_cost.analyses_per_day", 35),
    getLatestPointInTimeSnapshot(prisma, "operational.scheduler_lag"),
    getLatestPointInTimeSnapshot(prisma, "operational.disabled_stores"),
    getLatestPointInTimeSnapshot(prisma, "operational.stores_on_failure_streak"),
    getLatestSnapshot(prisma, "operational.promo_redemptions", window),
    getRetentionCohorts(prisma),
  ]);

  const byPlan = (points: { dimension: string; value: number }[]): Record<PlanTier, number> => ({
    FREE: valueFor(points, "FREE"),
    BASIC: valueFor(points, "BASIC"),
    BUSINESS: valueFor(points, "BUSINESS"),
  });

  // Every rolled-up snapshot for this window was computed by the same
  // worker run — any one of them (that isn't empty) carries the real computedAt.
  const computedAt = mrrTotal[0]?.computedAt ?? funnelPoints.flat()[0]?.computedAt ?? null;

  return {
    window,
    computedAt,
    funnel: FUNNEL_STEPS.map((s, i) => ({ key: s.key, label: s.label, count: funnelPoints[i][0]?.value ?? 0 })),
    activation: {
      signups: activationSignups[0]?.value ?? 0,
      activatedWithin24h: activationActivated[0]?.value ?? 0,
      watchedWithin7d: activationWatched[0]?.value ?? 0,
    },
    revenue: {
      mrrCentsByPlan: byPlan(mrrByPlan),
      mrrCentsTotal: mrrTotal[0]?.value ?? 0,
      arpuCents: arpu[0]?.value ?? 0,
      newMrrCents: newMrr[0]?.value ?? 0,
      expansionMrrCents: expansionMrr[0]?.value ?? 0,
      contractionMrrCents: contractionMrr[0]?.value ?? 0,
      churnedMrrCents: churnedMrr[0]?.value ?? 0,
      activeSubscriptionsByPlan: byPlan(activeSubsByPlan),
      activeSubscriptionsBySource: activeSubsBySource.map((p) => ({ source: p.dimension, count: p.value })),
    },
    usageCost: {
      analysesByPlan: byPlan(analysesByPlan),
      crawlVolume: crawlVolume[0]?.value ?? 0,
      crawlFailures: crawlFailures[0]?.value ?? 0,
      serpApiCalls: serpApiCalls[0]?.value ?? 0,
      serpApiCostCents: serpApiCostCents[0]?.value ?? 0,
      activeBusinessAccounts: activeBusinessAccounts[0]?.value ?? 0,
      costPerActiveBusinessAccountCents: costPerActiveBusinessAccountCents[0]?.value ?? 0,
      dailyTrend: dailyTrend.map((p) => ({ day: p.day, plan: p.dimension as PlanTier, count: p.value })),
    },
    operational: {
      schedulerLag: schedulerLag?.value ?? 0,
      disabledStores: disabledStores?.value ?? 0,
      storesOnFailureStreak: storesOnFailureStreak?.value ?? 0,
      promoRedemptions: promoRedemptions[0]?.value ?? 0,
    },
    retention: retentionCohorts,
  };
}
