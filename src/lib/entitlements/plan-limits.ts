/**
 * The single source of truth for what a plan is entitled to. Every other
 * piece of code — analysis-usage.ts, monitoring/watch.ts, future API
 * routes — reads limits from here rather than string-comparing `plan`
 * itself, so a new plan or a changed limit is a one-place edit.
 *
 * Deliberately Prisma-free (same convention as monitoring/policy.ts):
 * PlanTier is hand-mirrored as a string union rather than imported from
 * @prisma/client, so this stays unit-testable with no DB.
 */

export type PlanTier = "FREE" | "BASIC" | "BUSINESS";

/**
 * `null` is the explicit, type-safe spelling of "unlimited" / "no fixed
 * expiry" throughout this file — never an arbitrary large integer. A
 * caller that forgets to handle the null case gets a TypeScript error at
 * the comparison, not a silently-wrong number.
 */
export type Limit = number | null;

export interface PlanLimits {
  maxUniqueAnalyses: Limit;
  maxActiveMonitoredStores: Limit;
  /** null = no commercial monitoring expiry. */
  monitoringDurationDays: Limit;
  /** Full free-report intelligence categories vs. the future paid-only ones. */
  historicalAccess: boolean;
  advancedIntelligence: boolean;
}

/**
 * BASIC and BUSINESS are retained enum values for existing-data compatibility.
 * Publicly, both map to the single future PAID offer; billing is deliberately
 * not modeled here.
 */
const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: {
    maxUniqueAnalyses: null,
    maxActiveMonitoredStores: 1,
    monitoringDurationDays: null,
    historicalAccess: true,
    advancedIntelligence: false,
  },
  BASIC: {
    maxUniqueAnalyses: null, // unlimited
    maxActiveMonitoredStores: 10,
    monitoringDurationDays: null,
    historicalAccess: true,
    advancedIntelligence: true,
  },
  BUSINESS: {
    maxUniqueAnalyses: null,
    maxActiveMonitoredStores: 10,
    monitoringDurationDays: null,
    historicalAccess: true,
    advancedIntelligence: true,
  },
};

export function getPlanLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan];
}

/** `count >= limit` misbehaves at `limit === null` — this is the one place that comparison happens. */
export function isUnderLimit(count: number, limit: Limit): boolean {
  return limit === null || count < limit;
}
