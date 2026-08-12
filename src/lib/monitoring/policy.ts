/**
 * The MonitoringPolicy abstraction: cadence and backoff as pure functions of
 * tier and failure count, not scattered through the scheduler. Nothing here
 * knows about subscriptions or plan names — FREE/PRO/BUSINESS map onto
 * CrawlTier later, at the boundary that assigns a tier, not in here.
 *
 * Deliberately Prisma-free (like crawl/ and diff/): CrawlTier is hand-mirrored
 * from schema.prisma rather than imported from @prisma/client, so this stays
 * unit-testable with no DB and no generated client required.
 */

export type CrawlTier = "HOT" | "WARM" | "COOL" | "COLD" | "DORMANT" | "DISABLED";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Matches CrawlTier's own doc comments in schema.prisma — one source of truth for the numbers. */
const TIER_CADENCE_MS: Record<CrawlTier, number | null> = {
  HOT: 8 * HOUR_MS, // "every 6-12h" — 8h as a concrete midpoint
  WARM: 1 * DAY_MS, // "daily"
  COOL: 7 * DAY_MS, // "weekly"
  COLD: 30 * DAY_MS, // "monthly"
  DORMANT: 90 * DAY_MS, // "quarterly"
  DISABLED: null, // "never"
};

/** null means "do not schedule" — DISABLED stores must never re-enter the due-query. */
export function nextCrawlAfterSuccess(tier: CrawlTier, now: Date): Date | null {
  const interval = TIER_CADENCE_MS[tier];
  return interval === null ? null : new Date(now.getTime() + interval);
}

const BASE_BACKOFF_MS = 1 * HOUR_MS;
const MAX_BACKOFF_MS = 48 * HOUR_MS;

/** Exponential backoff, capped — failureStreak is the count AFTER this failure. */
export function nextCrawlAfterFailure(failureStreak: number, now: Date): Date {
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, failureStreak - 1), MAX_BACKOFF_MS);
  return new Date(now.getTime() + backoff);
}

/** Consecutive failures after which a store stops being scheduled at all. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export function shouldDemoteToDisabled(failureStreak: number): boolean {
  return failureStreak >= MAX_CONSECUTIVE_FAILURES;
}

/** The tier a store gets on its very first baseline — matches CrawlTier's own "COLD: corpus-seeded" framing: passive monitoring by default, no opt-in gate, upgradeable to a faster tier later. */
export const DEFAULT_TIER_ON_BASELINE: CrawlTier = "COLD";

export function isMonitorable(tier: CrawlTier): boolean {
  return tier !== "DISABLED";
}
