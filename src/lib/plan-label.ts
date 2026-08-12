import type { PlanTier } from "./entitlements/plan-limits";

/** The one place that turns a PlanTier into user-facing copy — "FREE" -> "Free". */
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
