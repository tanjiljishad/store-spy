import type { PrismaClient } from "@prisma/client";
import { getFunnelCounts } from "./funnel";
import { getActivationMetrics } from "./activation";
import { getRevenueMetrics } from "./revenue";
import { getCohortRetention } from "./retention";
import { getUsageCostMetrics, getDailyAnalysesTrend } from "./usage-cost";
import { getOperationalMetrics } from "./operational";
import { STANDARD_WINDOWS, addUtcMonths, resolveWindow, startOfUtcMonth, type StandardWindow } from "./window";

/**
 * Milestone 12 Section 3.2: "these are aggregate queries over the whole
 * Event/Crawl/AnalysisUsage tables. Do not run them synchronously on page
 * load. Compute into a MetricSnapshot table on a scheduled worker tick
 * (hourly)... Add the raw queries first, then the snapshot layer."
 *
 * The worker's own tick runs every 5 minutes (scripts/worker.ts) - far more
 * often than "hourly" - so this module self-gates: computeAndStoreSnapshots()
 * checks the most recent MetricSnapshot.computedAt across the whole table
 * and no-ops if less than SNAPSHOT_MIN_INTERVAL_MS has passed, the same
 * "cheap to call every tick, only does real work on its own cadence"
 * shape monitoring/scheduler.ts's per-store nextCrawlAt claim already uses,
 * one level up (here: a single global gate, not per-row).
 *
 * Every (metricKey, dimension, windowStart, windowEnd) tuple is UPSERTed,
 * never INSERTed unconditionally - see MetricSnapshot's own schema.prisma
 * doc comment for why that's also the table's declared unique index.
 * Rolled-up (rolling-window) metrics additionally need pruneStaleRolledUpRows()
 * below, since their windowEnd advances every run - see its own comment.
 */
const SNAPSHOT_MIN_INTERVAL_MS = 55 * 60_000; // hourly, with a 5-minute margin below the worker's own poll granularity so it never waits a full extra tick

const RETENTION_COHORT_MONTHS = 12;
const DAILY_TREND_DAYS = 35;

interface SnapshotRow {
  metricKey: string;
  dimension: string;
  windowStart: Date;
  windowEnd: Date;
  value: number;
}

function row(metricKey: string, value: number, windowStart: Date, windowEnd: Date, dimension = ""): SnapshotRow {
  return { metricKey, dimension, windowStart, windowEnd, value };
}

async function buildRolledUpRows(prisma: PrismaClient, window: StandardWindow, now: Date): Promise<SnapshotRow[]> {
  const { windowStart, windowEnd } = resolveWindow(window, now);
  const suffix = `:${window}`;
  const rows: SnapshotRow[] = [];

  const funnel = await getFunnelCounts(prisma, windowStart, windowEnd);
  rows.push(
    row(`funnel.anonymous_analyses${suffix}`, funnel.anonymousAnalyses, windowStart, windowEnd),
    row(`funnel.signups${suffix}`, funnel.signups, windowStart, windowEnd),
    row(`funnel.first_analyses${suffix}`, funnel.firstAnalyses, windowStart, windowEnd),
    row(`funnel.first_watches${suffix}`, funnel.firstWatches, windowStart, windowEnd),
    row(`funnel.paid_conversions${suffix}`, funnel.firstPaidConversions, windowStart, windowEnd),
  );

  const activation = await getActivationMetrics(prisma, windowStart, windowEnd);
  rows.push(
    row(`activation.signups${suffix}`, activation.signups, windowStart, windowEnd),
    row(`activation.activated_24h${suffix}`, activation.activatedWithin24h, windowStart, windowEnd),
    row(`activation.watched_7d${suffix}`, activation.watchedWithin7d, windowStart, windowEnd),
  );

  const revenue = await getRevenueMetrics(prisma, windowStart, windowEnd);
  for (const plan of ["FREE", "BASIC", "BUSINESS"] as const) {
    rows.push(row(`revenue.mrr_cents${suffix}`, revenue.mrrCentsByPlan[plan], windowStart, windowEnd, plan));
    rows.push(row(`revenue.active_subscriptions${suffix}`, revenue.activeSubscriptionsByPlan[plan], windowStart, windowEnd, plan));
  }
  for (const [source, count] of Object.entries(revenue.activeSubscriptionsBySource)) {
    rows.push(row(`revenue.active_subscriptions_by_source${suffix}`, count, windowStart, windowEnd, source));
  }
  rows.push(
    row(`revenue.mrr_cents_total${suffix}`, revenue.mrrCentsTotal, windowStart, windowEnd),
    row(`revenue.arpu_cents${suffix}`, revenue.arpuCents ?? 0, windowStart, windowEnd),
    row(`revenue.new_mrr_cents${suffix}`, revenue.newMrrCents, windowStart, windowEnd),
    row(`revenue.expansion_mrr_cents${suffix}`, revenue.expansionMrrCents, windowStart, windowEnd),
    row(`revenue.contraction_mrr_cents${suffix}`, revenue.contractionMrrCents, windowStart, windowEnd),
    row(`revenue.churned_mrr_cents${suffix}`, revenue.churnedMrrCents, windowStart, windowEnd),
  );

  const usageCost = await getUsageCostMetrics(prisma, windowStart, windowEnd);
  for (const plan of ["FREE", "BASIC", "BUSINESS"] as const) {
    rows.push(row(`usage_cost.analyses${suffix}`, usageCost.analysesByPlan[plan], windowStart, windowEnd, plan));
  }
  rows.push(
    row(`usage_cost.crawl_volume${suffix}`, usageCost.crawlVolume, windowStart, windowEnd),
    row(`usage_cost.crawl_failures${suffix}`, usageCost.crawlFailures, windowStart, windowEnd),
    row(`usage_cost.serpapi_calls${suffix}`, usageCost.serpApiCalls, windowStart, windowEnd),
    row(`usage_cost.serpapi_cost_cents${suffix}`, usageCost.serpApiCostCents, windowStart, windowEnd),
    row(`usage_cost.active_business_accounts${suffix}`, usageCost.activeBusinessAccountCount, windowStart, windowEnd),
    row(
      `usage_cost.cost_per_active_business_account_cents${suffix}`,
      usageCost.costPerActiveBusinessAccountCents ?? 0,
      windowStart,
      windowEnd,
    ),
  );

  const operational = await getOperationalMetrics(prisma, now, windowStart, windowEnd);
  // schedulerLagCount/disabledStoreCount/storesOnFailureStreak are
  // point-in-time, not windowed — genuinely the SAME value on every call to
  // this function regardless of `window`. getOperationalMetrics() bundles
  // all four of its queries into one Promise.all (see its own doc comment),
  // so computing it once per STANDARD_WINDOW is an acceptable, cheap
  // redundant query — but emitting these three rows on every call would
  // upsert the identical (metricKey, "", now, now) row four times per run
  // for no reason. Only the first window's call emits them.
  if (window === STANDARD_WINDOWS[0]) {
    rows.push(
      row("operational.scheduler_lag", operational.schedulerLagCount, now, now),
      row("operational.disabled_stores", operational.disabledStoreCount, now, now),
      row("operational.stores_on_failure_streak", operational.storesOnFailureStreak, now, now),
    );
  }
  rows.push(row(`operational.promo_redemptions${suffix}`, operational.promoRedemptionsInWindow, windowStart, windowEnd));

  return rows;
}

async function buildRetentionRows(prisma: PrismaClient, now: Date): Promise<SnapshotRow[]> {
  const cohortRangeEnd = startOfUtcMonth(now);
  const cohortRangeStart = addUtcMonths(cohortRangeEnd, -RETENTION_COHORT_MONTHS);
  const cohorts = await getCohortRetention(prisma, cohortRangeStart, cohortRangeEnd);

  const rows: SnapshotRow[] = [];
  for (const c of cohorts) {
    const monthEnd = addUtcMonths(c.cohortMonth, 1);
    rows.push(
      row("retention.cohort_size", c.cohortSize, c.cohortMonth, monthEnd),
      row("retention.ever_paid", c.everPaid, c.cohortMonth, monthEnd),
      row("retention.currently_paid", c.currentlyPaid, c.cohortMonth, monthEnd),
    );
  }
  return rows;
}

async function buildDailyTrendRows(prisma: PrismaClient, now: Date): Promise<SnapshotRow[]> {
  const points = await getDailyAnalysesTrend(prisma, DAILY_TREND_DAYS, now);
  return points.map((p) => row("usage_cost.analyses_per_day", p.count, p.day, new Date(p.day.getTime() + 24 * 60 * 60_000), p.plan));
}

export interface ComputeSnapshotsResult {
  computed: boolean;
  rowsWritten: number;
}

const ROLLING_WINDOW_SUFFIX_RE = /:(1d|7d|30d|90d)$/;

/** A rolled-up (rolling-window) metric key carries a ":<window>" suffix - see buildRolledUpRows()'s `suffix` above. */
function isRollingWindowMetric(metricKey: string): boolean {
  return ROLLING_WINDOW_SUFFIX_RE.test(metricKey);
}

/**
 * Rolled-up metrics' windowEnd is "now truncated to the hour" - a NEW value
 * on every run, unlike retention/daily-trend rows, which are pinned to
 * calendar month/day boundaries and so naturally upsert the same row when
 * recomputed. Without this prune, every hourly recompute would leave the
 * PREVIOUS hour's row in place under a different (now-stale) windowEnd and
 * insert a fresh one next to it, growing this table by one row per metric
 * per hour forever - breaking the "read snapshots only, one current row
 * per metric" shape the dashboard is built around. Deletes only
 * strictly-older rows for the exact (metricKey, dimension) pairs this run
 * just recomputed, so a metric that stops being emitted (e.g. a plan
 * removed) simply keeps its last known row rather than being silently
 * deleted by an unrelated run.
 *
 * Keyed on a nested Map (metricKey -> dimension -> latest windowEnd) rather
 * than a joined string key, so no delimiter choice has to be assumed safe
 * against every current and future dimension value.
 */
async function pruneStaleRolledUpRows(prisma: PrismaClient, freshRows: SnapshotRow[]): Promise<void> {
  const latestWindowEndByMetric = new Map<string, Map<string, Date>>();
  for (const r of freshRows) {
    if (!isRollingWindowMetric(r.metricKey)) continue;
    let byDimension = latestWindowEndByMetric.get(r.metricKey);
    if (!byDimension) {
      byDimension = new Map<string, Date>();
      latestWindowEndByMetric.set(r.metricKey, byDimension);
    }
    const existing = byDimension.get(r.dimension);
    if (!existing || r.windowEnd > existing) byDimension.set(r.dimension, r.windowEnd);
  }
  for (const [metricKey, byDimension] of latestWindowEndByMetric) {
    for (const [dimension, windowEnd] of byDimension) {
      await prisma.metricSnapshot.deleteMany({ where: { metricKey, dimension, windowEnd: { lt: windowEnd } } });
    }
  }
}

export async function computeAndStoreSnapshots(prisma: PrismaClient, now: Date = new Date()): Promise<ComputeSnapshotsResult> {
  const latest = await prisma.metricSnapshot.aggregate({ _max: { computedAt: true } });
  if (latest._max.computedAt && now.getTime() - latest._max.computedAt.getTime() < SNAPSHOT_MIN_INTERVAL_MS) {
    return { computed: false, rowsWritten: 0 };
  }

  const rolledUp = await Promise.all(STANDARD_WINDOWS.map((w) => buildRolledUpRows(prisma, w, now)));
  const retention = await buildRetentionRows(prisma, now);
  const dailyTrend = await buildDailyTrendRows(prisma, now);
  const rows = [...rolledUp.flat(), ...retention, ...dailyTrend];

  await pruneStaleRolledUpRows(prisma, rows);

  const computedAt = now;
  // One upsert per row rather than a bulk statement: MetricSnapshot's own
  // unique index IS the upsert key, and Prisma's client has no bulk-upsert
  // primitive - createMany has no ON CONFLICT DO UPDATE. Volume is bounded
  // (a few hundred rows at most: ~50 rolled-up metrics x 4 windows, 12
  // cohort-months x 3 metrics, 35 days x 3 plans) and this runs once an
  // hour from the worker, off the request path - a per-row round trip here
  // is not the kind of cost persist.ts's own bulk-statement discipline
  // exists to avoid (see that file's own doc comment on why THAT path
  // can't afford one round trip per product).
  await prisma.$transaction(
    rows.map((r) =>
      prisma.metricSnapshot.upsert({
        where: {
          metricKey_dimension_windowStart_windowEnd: {
            metricKey: r.metricKey,
            dimension: r.dimension,
            windowStart: r.windowStart,
            windowEnd: r.windowEnd,
          },
        },
        create: { ...r, computedAt },
        update: { value: r.value, computedAt },
      }),
    ),
  );

  return { computed: true, rowsWritten: rows.length };
}
