import type { PlanTier } from "./plan-limits";

/**
 * Milestone 12 §1.5: the one machine-readable shape every entitlement
 * rejection across the app returns, so the UI can render the right upgrade
 * prompt instead of a generic error. Three independent axes reuse this same
 * envelope: the rolling analysis quota (analysis-usage.ts), the monitored-
 * store count (monitoring/watch.ts), and a FREE user's expired trial
 * (also monitoring/watch.ts).
 */
export type LimitReachedKind = "ANALYSES_PER_DAY" | "MONITORED_STORES" | "TRIAL_EXPIRED";

export interface LimitReachedResponse {
  code: "LIMIT_REACHED";
  limit: LimitReachedKind;
  current: number;
  max: number;
  /** Present only for windowed limits — omitted (not null) when there's nothing to reset, e.g. TRIAL_EXPIRED. */
  resetsAt?: string;
  upgradeTo: "BASIC" | "BUSINESS";
}

/** The next plan up from the caller's current one — the natural upgrade target for a LIMIT_REACHED prompt. A BUSINESS caller has nothing higher to point at; BUSINESS is the least-wrong answer the response shape's own two-option type allows. */
export function nextPlanUp(plan: PlanTier): "BASIC" | "BUSINESS" {
  return plan === "FREE" ? "BASIC" : "BUSINESS";
}

export function limitReached(args: {
  limit: LimitReachedKind;
  current: number;
  max: number;
  resetsAt?: Date | null;
  plan: PlanTier;
}): LimitReachedResponse {
  return {
    code: "LIMIT_REACHED",
    limit: args.limit,
    current: args.current,
    max: args.max,
    ...(args.resetsAt ? { resetsAt: args.resetsAt.toISOString() } : {}),
    upgradeTo: nextPlanUp(args.plan),
  };
}
