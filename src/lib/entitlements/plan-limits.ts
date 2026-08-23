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
  /**
   * Milestone 12 §1.1: rolling-24h analysis quota — replaces the old
   * lifetime "unique stores ever analyzed" ceiling entirely. See
   * entitlements/analysis-usage.ts's countAnalysesInWindow().
   */
  maxAnalysesPer24h: Limit;
  maxActiveMonitoredStores: Limit;
  /** null = no commercial monitoring expiry. */
  monitoringDurationDays: Limit;
  /**
   * Milestone 12 §1.4, per D1: days from account creation until a FREE
   * user's monitoring stops being free. null = no trial ceiling (every
   * paid plan). See monitoring/watch.ts's startMonitoring().
   */
  freeTrialDays: Limit;
  /** Full free-report intelligence categories vs. the future paid-only ones. */
  historicalAccess: boolean;
  advancedIntelligence: boolean;
}

/**
 * Milestone 12 §1.1 final plan matrix — the single source of truth; nothing
 * else in the codebase may hardcode any of these numbers. BASIC and
 * BUSINESS are no longer identical: BUSINESS is marketed as "unlimited,
 * fair use up to 100/day" — see analysis-usage.ts and the LIMIT_REACHED
 * response shape for how the hard 100 cap coexists with that copy without
 * ever being silently exceeded.
 */
const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: {
    maxAnalysesPer24h: 10,
    maxActiveMonitoredStores: 1,
    monitoringDurationDays: null,
    freeTrialDays: 30,
    historicalAccess: true,
    advancedIntelligence: false,
  },
  BASIC: {
    maxAnalysesPer24h: 50,
    maxActiveMonitoredStores: 20,
    monitoringDurationDays: null,
    freeTrialDays: null,
    historicalAccess: true,
    advancedIntelligence: true,
  },
  BUSINESS: {
    maxAnalysesPer24h: 100,
    maxActiveMonitoredStores: 50,
    monitoringDurationDays: null,
    freeTrialDays: null,
    historicalAccess: true,
    advancedIntelligence: true,
  },
};

/** Anonymous callers are not a PlanTier (no account exists yet) — kept separate rather than forcing a 4th matrix row onto a type that means "signed-in user's plan" everywhere else. */
export const ANONYMOUS_ANALYSES_PER_24H = 3;

export function getPlanLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan];
}

/** `count >= limit` misbehaves at `limit === null` — this is the one place that comparison happens. */
export function isUnderLimit(count: number, limit: Limit): boolean {
  return limit === null || count < limit;
}
