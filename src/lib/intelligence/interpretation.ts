/**
 * A small, deterministic "what this means" layer over two ALREADY-COMPUTED,
 * ALREADY-OBSERVED signals (see docs/milestone-7-subphase-c-completion-
 * report.md, Objective 10): store-level catalog growth direction
 * (monitoring/activity.ts's computeGrowthSignals()) and aggregate bestseller
 * rank momentum (growth/bestseller.ts's per-product `momentum`). No LLM, no
 * new query, no new intelligence — this module computes nothing that isn't
 * already OBSERVED elsewhere; it only decides whether two existing signals
 * agree closely enough to state a conservative, evidence-cited sentence.
 *
 * Deliberately conservative: it takes no position unless BOTH signals point
 * the same direction with real support (catalog growth must be an actual
 * CATALOG_EXPANSION/CONTRACTION signal, not STEADY/PRICE_ACTIVITY/absent;
 * bestseller momentum must be a clear majority among products that have one
 * at all, not a single product). Any disagreement, absence, or ambiguity
 * yields `null` — "say nothing" is a valid, expected, common output, not a
 * fallback error path.
 *
 * Never says "sales," "revenue," or "growing" in the business-outcome
 * sense — see INTERPRETATION_STRINGS below. This is the one place the
 * product is allowed to combine two independently-sourced signals into a
 * single sentence, and it must never imply more than "storefront activity,"
 * which is the only claim these two signals jointly support.
 */

export type CatalogDirection = "EXPANDING" | "CONTRACTING" | null;
export type BestsellerDirection = "IMPROVING" | "DECLINING" | null;

export interface StoreInterpretation {
  headline: string;
  detail: string;
}

const INTERPRETATION_STRINGS: Record<"EXPANDING_IMPROVING" | "CONTRACTING_DECLINING", StoreInterpretation> = {
  EXPANDING_IMPROVING: {
    headline: "Storefront activity increasing",
    detail:
      "Recent catalog expansion and improving product-rank movement — not confirmation of sales or revenue growth.",
  },
  CONTRACTING_DECLINING: {
    headline: "Storefront activity decreasing",
    detail:
      "Recent catalog contraction and declining product-rank movement — not confirmation of reduced sales or revenue.",
  },
};

/** PURE. Reads only `kind` — matches monitoring/activity.ts's GrowthSignal shape without importing it, so this module has zero dependency on any Prisma-touching code. */
export function catalogDirectionFromSignals(signals: Array<{ kind: string }>): CatalogDirection {
  if (signals.some((s) => s.kind === "CATALOG_EXPANSION")) return "EXPANDING";
  if (signals.some((s) => s.kind === "CATALOG_CONTRACTION")) return "CONTRACTING";
  return null;
}

/**
 * Requires at least 2 products with a non-null momentum and a genuine
 * majority (strictly more than half) in one direction — one improving
 * product out of twenty is not "the store's bestsellers are improving."
 */
export function bestsellerDirectionFromMomentum(momentums: Array<"IMPROVING" | "DECLINING" | "STABLE" | null>): BestsellerDirection {
  const decided = momentums.filter((m): m is "IMPROVING" | "DECLINING" | "STABLE" => m !== null);
  if (decided.length < 2) return null;

  const improving = decided.filter((m) => m === "IMPROVING").length;
  const declining = decided.filter((m) => m === "DECLINING").length;

  if (improving > decided.length / 2) return "IMPROVING";
  if (declining > decided.length / 2) return "DECLINING";
  return null;
}

/** PURE. Returns null — no interpretation — unless both signals independently agree. */
export function deriveInterpretation(
  catalogDirection: CatalogDirection,
  bestsellerDirection: BestsellerDirection,
): StoreInterpretation | null {
  if (catalogDirection === "EXPANDING" && bestsellerDirection === "IMPROVING") {
    return INTERPRETATION_STRINGS.EXPANDING_IMPROVING;
  }
  if (catalogDirection === "CONTRACTING" && bestsellerDirection === "DECLINING") {
    return INTERPRETATION_STRINGS.CONTRACTING_DECLINING;
  }
  return null;
}
