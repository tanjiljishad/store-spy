import { Prisma } from "@prisma/client";

/**
 * Milestone 12 §3.1/§3.2: every raw SQL query in this directory is a
 * date-bucketed or date-windowed aggregate, which makes this the module
 * AGENTS.md's Database time rule warns is "the most likely place for a
 * repeat" of the 6-hour bug Milestone 12 Phase 1 shipped and fixed (see the
 * completion report). Two DIFFERENT rules apply depending on what a query
 * is doing with a timestamp column, and confusing them reintroduces the bug
 * either way:
 *
 * 1. COMPARING a bound JS `Date` parameter against a `timestamp(3)` (no tz)
 *    column (e.g. `WHERE "createdAt" >= <param>`) — the driver sends a JS
 *    Date as a `timestamptz`-typed parameter, and Postgres casts
 *    timestamptz -> timestamp through the SESSION's TimeZone GUC, not UTC.
 *    Every window boundary in this directory MUST go through utcParam()
 *    below before being interpolated into a query.
 *
 * 2. BUCKETING a `timestamp(3)` column itself (`date_trunc('day'|'month',
 *    "col")`) — the OPPOSITE case, and utcParam() must NOT be applied here.
 *    Every timestamp(3) column this directory reads already holds UTC
 *    wall-clock values with no attached zone (Prisma's query engine writes
 *    them client-side as UTC — see the User.freeTrialEndsAt doc comment in
 *    schema.prisma), so date_trunc on the bare column performs no zone
 *    conversion at all and buckets correctly by UTC calendar day/month
 *    regardless of session TimeZone. Wrapping the column in `AT TIME ZONE
 *    'UTC'` first would convert it TO a timestamptz, and date_trunc on a
 *    timestamptz DOES consult the session zone to decide where a day
 *    starts — that would silently REINTRODUCE the exact bug this file
 *    exists to prevent. See timezone-safety.integration.test.ts, which pins
 *    a pathological session timezone and asserts both rules hold.
 */
export function utcParam(d: Date): Prisma.Sql {
  return Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
}

export type StandardWindow = "1d" | "7d" | "30d" | "90d";

export const STANDARD_WINDOWS: readonly StandardWindow[] = ["1d", "7d", "30d", "90d"];

const WINDOW_DAYS: Record<StandardWindow, number> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 };

export interface WindowRange {
  windowStart: Date;
  windowEnd: Date;
}

/**
 * `windowEnd` is `now` truncated to the hour, not the raw instant — so two
 * calls within the same clock hour (e.g. the worker's own self-gate check,
 * then the actual computation moments later) resolve to the IDENTICAL
 * windowStart/windowEnd pair. That identity is what makes MetricSnapshot's
 * upsert key (metricKey, dimension, windowStart, windowEnd) overwrite the
 * same row on every hourly recompute instead of drifting by milliseconds
 * and silently accumulating a new row per tick.
 */
export function resolveWindow(window: StandardWindow, now: Date = new Date()): WindowRange {
  const windowEnd = new Date(now);
  windowEnd.setUTCMinutes(0, 0, 0);
  const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS[window] * 24 * 60 * 60_000);
  return { windowStart, windowEnd };
}

/** Midnight UTC on the day containing `d` — the boundary a daily trend bucket (usage-cost.ts) and a cohort month both build on. */
export function startOfUtcDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

export function addUtcDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60_000);
}

/** The 1st of the UTC calendar month containing `d` — cohort-month boundaries (retention.ts). */
export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addUtcMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}
