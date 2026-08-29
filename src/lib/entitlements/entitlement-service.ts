import type { Limit, PlanTier } from "./plan-limits";
import { getPlanLimits } from "./plan-limits";

/**
 * Coarse per-tier lookups over plan-limits.ts's display/cascade matrix. B2
 * 2·B: NOT an access-control boundary any more — every gate calls
 * `resolveEntitlement()` per feature against the control plane. These feed
 * the upgrade-prompt copy (UpgradePrompt.tsx), the FREE downgrade-cascade
 * limit (subscription-sweep.ts), and the FREE-watch duration ceiling
 * (watch.ts).
 */
export type BooleanCapability = "ADVANCED_INTELLIGENCE";

export function hasCapability(plan: PlanTier, capability: BooleanCapability): boolean {
  switch (capability) {
    case "ADVANCED_INTELLIGENCE":
      return getPlanLimits(plan).advancedIntelligence;
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
