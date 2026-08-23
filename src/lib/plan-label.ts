import type { PlanTier } from "./entitlements/plan-limits";

/**
 * The one place that turns a PlanTier into user-facing copy — "FREE" ->
 * "Free". Milestone 12 un-collapses BASIC and BUSINESS into genuinely
 * different tiers (different monitored-store limits, different daily
 * analysis quotas, different prices) — collapsing both to "Paid" here would
 * hide that distinction everywhere this is displayed.
 */
export function planLabel(plan: PlanTier): string {
  switch (plan) {
    case "FREE":
      return "Free";
    case "BASIC":
      return "Basic";
    case "BUSINESS":
      return "Business";
  }
}
