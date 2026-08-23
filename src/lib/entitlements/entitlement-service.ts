import type { Limit, PlanTier } from "./plan-limits";
import { getPlanLimits } from "./plan-limits";

/**
 * Boolean-shaped capabilities only — numeric ones (MAX_UNIQUE_ANALYSES,
 * MAX_ACTIVE_MONITORED_STORES, MONITORING_DURATION_DAYS) need an actual
 * number, not a yes/no, so they're exposed as typed getters below instead
 * of being forced through a boolean hasCapability(). Both read from the
 * same plan-limits.ts table — this file is the only place in the app that
 * should ever read `user.plan` and turn it into a decision.
 */
export type BooleanCapability = "HISTORICAL_ACCESS" | "ADVANCED_INTELLIGENCE";

export function hasCapability(plan: PlanTier, capability: BooleanCapability): boolean {
  const limits = getPlanLimits(plan);
  switch (capability) {
    case "HISTORICAL_ACCESS":
      return limits.historicalAccess;
    case "ADVANCED_INTELLIGENCE":
      return limits.advancedIntelligence;
  }
}

/** null means unlimited — see plan-limits.ts's Limit type and isUnderLimit(). */
export function maxAnalysesPer24h(plan: PlanTier): Limit {
  return getPlanLimits(plan).maxAnalysesPer24h;
}

export function maxActiveMonitoredStores(plan: PlanTier): Limit {
  return getPlanLimits(plan).maxActiveMonitoredStores;
}

/** null means continuous monitoring — no fixed expiry. */
export function monitoringDurationDays(plan: PlanTier): Limit {
  return getPlanLimits(plan).monitoringDurationDays;
}

/** null means no free-trial ceiling (every paid plan). See watch.ts's startMonitoring(). */
export function freeTrialDays(plan: PlanTier): Limit {
  return getPlanLimits(plan).freeTrialDays;
}
