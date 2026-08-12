/**
 * Marketing-collection cadence as a pure function of tier — same shape as
 * monitoring/policy.ts, deliberately NOT reusing its numbers. Shopify
 * crawling is free (self-hosted); marketing collection calls a paid vendor,
 * so its cadence must be independently conservative regardless of what
 * Shopify's tier cadence happens to be. Hand-mirrored CrawlTier, not
 * imported from @prisma/client, for the same Prisma-free-unit-testability
 * reason as everywhere else in this layer.
 *
 * Deliberately simple for this first version (per the Sub-phase B spec's
 * explicit warning against over-engineering scheduling): a flat cadence per
 * tier, and a flat retry delay on failure — no streak-based exponential
 * backoff, no DISABLED-demotion state machine for marketing specifically.
 * Revisit with real vendor cost/failure data before adding either.
 */

export type CrawlTier = "HOT" | "WARM" | "COOL" | "COLD" | "DORMANT" | "DISABLED";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const TIER_CADENCE_MS: Record<CrawlTier, number | null> = {
  HOT: 1 * DAY_MS,
  WARM: 3 * DAY_MS,
  COOL: 7 * DAY_MS,
  COLD: 30 * DAY_MS,
  DORMANT: 90 * DAY_MS,
  DISABLED: null,
};

/** null means "do not schedule" — DISABLED stores must never re-enter the due-query. */
export function nextMarketingCollectionAfterSuccess(tier: CrawlTier, now: Date): Date | null {
  const interval = TIER_CADENCE_MS[tier];
  return interval === null ? null : new Date(now.getTime() + interval);
}

/**
 * Flat retry delay for ANY UNAVAILABLE outcome (vendor down, malformed
 * response, no advertiser found, ...). Long enough to not hammer a vendor
 * that's having a bad day or a store with no advertiser record; short
 * enough that a real transient blip self-heals within a day.
 */
const FAILURE_RETRY_MS = 1 * DAY_MS;

export function nextMarketingCollectionAfterFailure(now: Date): Date {
  return new Date(now.getTime() + FAILURE_RETRY_MS);
}
