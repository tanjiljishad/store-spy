/**
 * Plan-tier primitives + a display/cascade mirror of the pricing matrix.
 *
 * As of B2 2·B the AUTHORITATIVE source for whether an account may do a thing,
 * and up to what ceiling, is the control plane (`resolveEntitlement()` per
 * feature). This file is no longer that source. What remains here:
 *   - `PlanTier` / `Limit` / `isUnderLimit()` / `ANONYMOUS_ANALYSES_PER_24H`
 *     — small primitives with no pricing knowledge, used app-wide.
 *   - `PLAN_LIMITS` / `getPlanLimits()` — a COARSE mirror of the tier matrix,
 *     read only by entitlement-service.ts for the upgrade-prompt copy, the
 *     FREE downgrade-cascade limit, and dashboard labels. `plan-limits.test.ts`
 *     asserts it agrees cell-for-cell with `PLAN_ENTITLEMENTS` in
 *     control-plane/provision.ts (what actually gets seeded). Never gate on it.
 *
 * Deliberately Prisma-free: PlanTier is hand-mirrored as a string union
 * rather than imported from @prisma/client, so this stays unit-testable with
 * no DB.
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
  /** Milestone 12 §1.1: rolling-24h analysis quota. */
  maxAnalysesPer24h: Limit;
  maxActiveMonitoredStores: Limit;
  /** null = no commercial monitoring expiry. */
  monitoringDurationDays: Limit;
  advancedIntelligence: boolean;
}

/**
 * Coarse mirror of the M12 tier matrix — display / downgrade-cascade only (see
 * this file's header). The control-plane entitlement quotas are the real thing;
 * `plan-limits.test.ts` asserts this matches `PLAN_ENTITLEMENTS` (provision.ts).
 */
const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: { maxAnalysesPer24h: 10, maxActiveMonitoredStores: 1, monitoringDurationDays: null, advancedIntelligence: false },
  BASIC: { maxAnalysesPer24h: 50, maxActiveMonitoredStores: 20, monitoringDurationDays: null, advancedIntelligence: true },
  BUSINESS: { maxAnalysesPer24h: 100, maxActiveMonitoredStores: 50, monitoringDurationDays: null, advancedIntelligence: true },
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
