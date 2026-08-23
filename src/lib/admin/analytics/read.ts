import type { PrismaClient } from "@prisma/client";
import type { StandardWindow } from "./window";

/**
 * Milestone 12 Section 3.2: "Server Components reading from snapshots."
 * The ONLY read path the /admin/analytics pages use — never a raw query
 * from funnel.ts/revenue.ts/etc. directly, which would put an aggregate
 * scan back on the request path.
 */
export interface SnapshotPoint {
  dimension: string;
  windowStart: Date;
  windowEnd: Date;
  value: number;
  computedAt: Date;
}

/** The most recent row for each dimension of one rolled-up metric at one standard window (e.g. "revenue.mrr_cents:30d" -> one row per plan). */
export async function getLatestSnapshot(
  prisma: PrismaClient,
  metricKey: string,
  window: StandardWindow,
): Promise<SnapshotPoint[]> {
  const rows = await prisma.metricSnapshot.findMany({
    where: { metricKey: `${metricKey}:${window}` },
    orderBy: { windowEnd: "desc" },
  });
  // One row per dimension: keep only the freshest windowEnd per dimension
  // (pruneStaleRolledUpRows() already enforces this at write time, but the
  // read side doesn't assume that invariant holds forever — a defensive
  // dedupe here costs nothing and stays correct even if that changes).
  const seen = new Set<string>();
  const latest: SnapshotPoint[] = [];
  for (const r of rows) {
    if (seen.has(r.dimension)) continue;
    seen.add(r.dimension);
    latest.push({ dimension: r.dimension, windowStart: r.windowStart, windowEnd: r.windowEnd, value: r.value, computedAt: r.computedAt });
  }
  return latest;
}

/** A point-in-time metric with no window suffix (operational.scheduler_lag, operational.disabled_stores, operational.stores_on_failure_streak). */
export async function getLatestPointInTimeSnapshot(prisma: PrismaClient, metricKey: string): Promise<SnapshotPoint | null> {
  const r = await prisma.metricSnapshot.findFirst({ where: { metricKey }, orderBy: { windowEnd: "desc" } });
  if (!r) return null;
  return { dimension: r.dimension, windowStart: r.windowStart, windowEnd: r.windowEnd, value: r.value, computedAt: r.computedAt };
}

export interface TrendPoint {
  day: Date;
  dimension: string;
  value: number;
}

/** The daily-trend series (usage_cost.analyses_per_day), most recent `days` calendar days, oldest first. */
export async function getDailyTrend(prisma: PrismaClient, metricKey: string, days: number, now: Date = new Date()): Promise<TrendPoint[]> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000);
  const rows = await prisma.metricSnapshot.findMany({
    where: { metricKey, windowStart: { gte: cutoff } },
    orderBy: { windowStart: "asc" },
  });
  return rows.map((r) => ({ day: r.windowStart, dimension: r.dimension, value: r.value }));
}

export interface CohortSnapshotRow {
  cohortMonth: Date;
  cohortSize: number;
  everPaid: number;
  currentlyPaid: number;
}

/** All retention cohort rows currently stored, most recent cohort first. */
export async function getRetentionCohorts(prisma: PrismaClient): Promise<CohortSnapshotRow[]> {
  const [sizeRows, everPaidRows, currentlyPaidRows] = await Promise.all([
    prisma.metricSnapshot.findMany({ where: { metricKey: "retention.cohort_size" }, orderBy: { windowStart: "desc" } }),
    prisma.metricSnapshot.findMany({ where: { metricKey: "retention.ever_paid" } }),
    prisma.metricSnapshot.findMany({ where: { metricKey: "retention.currently_paid" } }),
  ]);
  const everPaidByMonth = new Map(everPaidRows.map((r) => [r.windowStart.getTime(), r.value]));
  const currentlyPaidByMonth = new Map(currentlyPaidRows.map((r) => [r.windowStart.getTime(), r.value]));

  return sizeRows.map((r) => ({
    cohortMonth: r.windowStart,
    cohortSize: r.value,
    everPaid: everPaidByMonth.get(r.windowStart.getTime()) ?? 0,
    currentlyPaid: currentlyPaidByMonth.get(r.windowStart.getTime()) ?? 0,
  }));
}
