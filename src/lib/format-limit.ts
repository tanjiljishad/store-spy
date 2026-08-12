import type { Limit } from "./entitlements/plan-limits";

/** Renders a plan Limit (number | null) for display — null is "Unlimited", never a fabricated large number. */
export function formatLimit(limit: Limit): string {
  return limit === null ? "Unlimited" : String(limit);
}
