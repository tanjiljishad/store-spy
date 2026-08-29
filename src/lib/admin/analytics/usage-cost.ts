import type { PrismaClient, CrawlStatus } from "@prisma/client";
import type { PlanTier } from "../../entitlements/plan-limits";
import { SERPAPI_COST_PER_CALL_CENTS } from "./vendor-cost";
import { startOfUtcDay, utcParam } from "./window";

/**
 * Milestone 12 §3.1: "analyses/day by plan, crawl volume, crawl failure
 * rate, and SerpAPI calls with their cost. At BUSINESS = 100 analyses/day
 * and $49/mo, per-analysis vendor cost is the difference between a healthy
 * margin and none. Surface cost per active account."
 *
 * "Cost per active BUSINESS account" specifically (not cost per account in
 * general, per the doc's own emphasis on the BUSINESS/$49/100-per-day
 * ratio): MarketingCollectionRun is STORE-scoped, not user-scoped, so
 * attributing SerpAPI spend to a plan requires joining through Watchlist —
 * "the SerpAPI cost of every store an ACTIVE BUSINESS watcher is
 * monitoring, divided by how many distinct BUSINESS accounts are watching
 * anything." A store watched by more than one BUSINESS account has its
 * cost counted once (EXISTS, not a join that would multiply rows) — the
 * vendor call happened once regardless of how many accounts watch that
 * store, so double-counting it per watcher would overstate real spend.
 *
 * B2 2·B commit 3d: every `plan` here is the account's CURRENTLY-EFFECTIVE
 * tier — the `plan_slug` of an ACTIVE control-plane subscription whose
 * `period_end` is null or in the future (the same condition resolveEntitlement
 * applies), COALESCEd to 'FREE' when there is none. A lapsed BASIC/BUSINESS
 * account is serving FREE-tier cost and is counted as FREE, not as the tier it
 * once bought — attributing its spend to a paid tier would overstate that
 * tier's cost and the paid-account denominator alike.
 */

const ZERO_BY_PLAN = (): Record<PlanTier, number> => ({ FREE: 0, BASIC: 0, BUSINESS: 0 });

export interface UsageCostMetrics {
  windowStart: Date;
  windowEnd: Date;
  analysesByPlan: Record<PlanTier, number>;
  crawlVolume: number;
  crawlFailures: number;
  crawlFailureRate: number | null;
  serpApiCalls: number;
  serpApiCostCents: number;
  businessWatchedSerpApiCalls: number;
  businessWatchedSerpApiCostCents: number;
  activeBusinessAccountCount: number;
  costPerActiveBusinessAccountCents: number | null;
}

export async function getUsageCostMetrics(prisma: PrismaClient, windowStart: Date, windowEnd: Date): Promise<UsageCostMetrics> {
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);
  const now = utcParam(new Date());

  const [analysesRows, crawlRows, serpRows, businessSerpRows, businessAccountRows] = await Promise.all([
    prisma.$queryRaw<{ plan: PlanTier; n: number }[]>`
      SELECT
        COALESCE((
          SELECT s.plan_slug FROM "control_plane"."subscriptions" s
          WHERE s."account_id" = 'acct_' || au."userId" AND s.status = 'ACTIVE'
            AND (s.period_end IS NULL OR s.period_end > ${now})
          ORDER BY s."created_at" DESC LIMIT 1
        ), 'FREE') AS plan,
        COUNT(*)::int AS n
      FROM "AnalysisUsage" au
      WHERE au."createdAt" >= ${start} AND au."createdAt" < ${end}
      GROUP BY 1
    `,
    prisma.$queryRaw<{ status: CrawlStatus; n: number }[]>`
      SELECT status, COUNT(*)::int AS n
      FROM "Crawl"
      WHERE "startedAt" >= ${start} AND "startedAt" < ${end}
      GROUP BY status
    `,
    prisma.$queryRaw<{ calls: number }[]>`
      SELECT COALESCE(SUM("vendorRequestCount"), 0)::int AS calls
      FROM "MarketingCollectionRun"
      WHERE "startedAt" >= ${start} AND "startedAt" < ${end}
    `,
    prisma.$queryRaw<{ calls: number }[]>`
      SELECT COALESCE(SUM(mcr."vendorRequestCount"), 0)::int AS calls
      FROM "MarketingCollectionRun" mcr
      WHERE mcr."startedAt" >= ${start} AND mcr."startedAt" < ${end}
        AND EXISTS (
          SELECT 1 FROM "Watchlist" w
          WHERE w."storeId" = mcr."storeId" AND w."monitoringStatus" = 'ACTIVE'
            AND EXISTS (
              SELECT 1 FROM "control_plane"."subscriptions" s
              WHERE s."account_id" = 'acct_' || w."userId" AND s.status = 'ACTIVE'
                AND s.plan_slug = 'BUSINESS' AND (s.period_end IS NULL OR s.period_end > ${now})
            )
        )
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT w."userId")::int AS n
      FROM "Watchlist" w
      WHERE w."monitoringStatus" = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM "control_plane"."subscriptions" s
          WHERE s."account_id" = 'acct_' || w."userId" AND s.status = 'ACTIVE'
            AND s.plan_slug = 'BUSINESS' AND (s.period_end IS NULL OR s.period_end > ${now})
        )
    `,
  ]);

  const analysesByPlan = ZERO_BY_PLAN();
  for (const r of analysesRows) analysesByPlan[r.plan] = r.n;

  let crawlVolume = 0;
  let crawlFailures = 0;
  for (const r of crawlRows) {
    crawlVolume += r.n;
    if (r.status === "FAILED") crawlFailures += r.n;
  }

  const serpApiCalls = serpRows[0].calls;
  const businessWatchedSerpApiCalls = businessSerpRows[0].calls;
  const activeBusinessAccountCount = businessAccountRows[0].n;
  const businessWatchedSerpApiCostCents = businessWatchedSerpApiCalls * SERPAPI_COST_PER_CALL_CENTS;

  return {
    windowStart,
    windowEnd,
    analysesByPlan,
    crawlVolume,
    crawlFailures,
    crawlFailureRate: crawlVolume === 0 ? null : crawlFailures / crawlVolume,
    serpApiCalls,
    serpApiCostCents: serpApiCalls * SERPAPI_COST_PER_CALL_CENTS,
    businessWatchedSerpApiCalls,
    businessWatchedSerpApiCostCents,
    activeBusinessAccountCount,
    costPerActiveBusinessAccountCents:
      activeBusinessAccountCount === 0 ? null : businessWatchedSerpApiCostCents / activeBusinessAccountCount,
  };
}

export interface DailyAnalysesPoint {
  day: Date;
  plan: PlanTier;
  count: number;
}

/**
 * The one metric this phase gives a per-day trend series (dashboard line
 * chart) rather than the standard rolled-up 1d/7d/30d/90d windows — "usage
 * and cost" is the metric group the doc phrases as an explicit daily rate
 * ("analyses/day by plan"), so it's the one where a day-by-day shape is
 * more decision-relevant than a handful of rolled-up totals.
 */
export async function getDailyAnalysesTrend(prisma: PrismaClient, days: number, now: Date = new Date()): Promise<DailyAnalysesPoint[]> {
  const windowEnd = startOfUtcDay(now);
  const windowStart = new Date(windowEnd.getTime() - days * 24 * 60 * 60_000);
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);
  const nowParam = utcParam(new Date());

  const rows = await prisma.$queryRaw<{ day: Date; plan: PlanTier; n: number }[]>`
    SELECT
      date_trunc('day', au."createdAt") AS day,
      COALESCE((
        SELECT s.plan_slug FROM "control_plane"."subscriptions" s
        WHERE s."account_id" = 'acct_' || au."userId" AND s.status = 'ACTIVE'
          AND (s.period_end IS NULL OR s.period_end > ${nowParam})
        ORDER BY s."created_at" DESC LIMIT 1
      ), 'FREE') AS plan,
      COUNT(*)::int AS n
    FROM "AnalysisUsage" au
    WHERE au."createdAt" >= ${start} AND au."createdAt" < ${end}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

  return rows.map((r) => ({ day: r.day, plan: r.plan, count: r.n }));
}
