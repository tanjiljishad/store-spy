import type { PrismaClient } from "@prisma/client";

/**
 * Product activity and growth signals, both derived live from real Event
 * rows and the current Product count — nothing cached, nothing invented.
 * StoreStats exists in the schema but is for a different, pre-existing
 * concern (the significance scorer's rarity term) and is never written by
 * anything yet; reusing it here would tie this feature to unrelated
 * infrastructure for no benefit, so this queries Event/Product directly.
 */

const PRICE_EVENT_TYPES = ["PRICE_DROP", "PRICE_INCREASE", "SALE_STARTED", "SALE_ENDED"] as const;

export interface ActivitySummary {
  windowDays: number;
  productsAdded: number;
  productsRemoved: number;
  /**
   * PRODUCT_RESTORED — a product that was MISSING/REMOVED reappearing.
   * Deliberately a separate counter from productsAdded, never merged into
   * it: a restoration and a genuinely new product are different facts (see
   * diff/engine.ts's own PRODUCT_ADDED vs PRODUCT_RESTORED event split).
   * Does NOT feed productCountWindowAgo's reconstruction below — that
   * formula's own doc comment already scopes it as an approximation that
   * only undoes ADDED/REMOVED; extending it to also undo restorations was
   * judged a separate, riskier change than this fix calls for (see
   * Milestone 7 Sub-phase B completion report).
   */
  productsRestored: number;
  priceChanges: number;
  totalProductChanges: number;
  currentProductCount: number;
  /**
   * Derived by undoing this window's net add/remove events from the current
   * count — an approximation (a product bouncing MISSING->ACTIVE mid-window
   * isn't fully reconciled), not a stored historical snapshot. Good enough
   * for a transparent "roughly how much did the catalog move" signal; not
   * meant to be an exact ledger.
   */
  productCountWindowAgo: number | null;
  productCountDelta: number | null;
  productCountDeltaPct: number | null;
  /** At least one real (non-baseline) crawl happened after the baseline — see hasEnoughHistory. */
  crawlsInWindow: number;
  /**
   * False until a second real crawl has happened. Before that, every number
   * above is trivially zero, and showing it as "no activity" would
   * misrepresent "we've only looked once" as "nothing changed" — the exact
   * fabricated-history failure mode this whole feature exists to avoid.
   */
  hasEnoughHistory: boolean;
}

export async function getActivitySummary(
  prisma: PrismaClient,
  storeId: string,
  windowDays = 7,
): Promise<ActivitySummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [productsAdded, productsRemoved, productsRestored, priceChanges, currentProductCount, crawlsInWindow, totalRealCrawls] =
    await Promise.all([
      prisma.event.count({
        where: { storeId, eventType: "PRODUCT_ADDED", backfilled: false, occurredAt: { gte: since } },
      }),
      prisma.event.count({
        where: { storeId, eventType: "PRODUCT_REMOVED", occurredAt: { gte: since } },
      }),
      prisma.event.count({
        where: { storeId, eventType: "PRODUCT_RESTORED", occurredAt: { gte: since } },
      }),
      prisma.event.count({
        where: { storeId, eventType: { in: [...PRICE_EVENT_TYPES] }, occurredAt: { gte: since } },
      }),
      prisma.product.count({ where: { storeId, status: "ACTIVE" } }),
      prisma.crawl.count({ where: { storeId, status: { in: ["OK", "PARTIAL"] }, startedAt: { gte: since } } }),
      prisma.crawl.count({ where: { storeId, status: { in: ["OK", "PARTIAL"] } } }),
    ]);

  const hasEnoughHistory = totalRealCrawls >= 2;
  const productCountWindowAgo = hasEnoughHistory ? currentProductCount - productsAdded + productsRemoved : null;
  const productCountDelta = productCountWindowAgo === null ? null : currentProductCount - productCountWindowAgo;
  const productCountDeltaPct =
    productCountDelta === null || !productCountWindowAgo
      ? null
      : Math.round((productCountDelta / productCountWindowAgo) * 1000) / 10;

  return {
    windowDays,
    productsAdded,
    productsRemoved,
    productsRestored,
    priceChanges,
    // Unchanged formula — deliberately does NOT fold in productsRestored,
    // to avoid changing this pre-existing field's value for any store that
    // has ever had a restoration. See productsRestored's own doc comment.
    totalProductChanges: productsAdded + productsRemoved + priceChanges,
    currentProductCount,
    productCountWindowAgo,
    productCountDelta,
    productCountDeltaPct,
    crawlsInWindow,
    hasEnoughHistory,
  };
}

export type GrowthSignalKind = "CATALOG_EXPANSION" | "CATALOG_CONTRACTION" | "PRICE_ACTIVITY" | "STEADY";

export interface GrowthSignal {
  kind: GrowthSignalKind;
  detail: string;
}

/**
 * Deterministic, explainable derivations only — no "growth score," no claim
 * about revenue. Each signal states exactly the observation behind it.
 */
export function computeGrowthSignals(summary: ActivitySummary): GrowthSignal[] {
  if (!summary.hasEnoughHistory) return [];

  const signals: GrowthSignal[] = [];

  if (summary.productCountDelta !== null && summary.productCountDelta > 0) {
    const pct = summary.productCountDeltaPct !== null ? ` (+${summary.productCountDeltaPct}%)` : "";
    signals.push({
      kind: "CATALOG_EXPANSION",
      detail: `+${summary.productCountDelta} products${pct} over the last ${summary.windowDays} days`,
    });
  } else if (summary.productCountDelta !== null && summary.productCountDelta < 0) {
    const pct = summary.productCountDeltaPct !== null ? ` (${summary.productCountDeltaPct}%)` : "";
    signals.push({
      kind: "CATALOG_CONTRACTION",
      detail: `${summary.productCountDelta} products${pct} over the last ${summary.windowDays} days`,
    });
  }

  if (summary.priceChanges > 0) {
    signals.push({
      kind: "PRICE_ACTIVITY",
      detail: `${summary.priceChanges} price ${summary.priceChanges === 1 ? "change" : "changes"} observed in the last ${summary.windowDays} days`,
    });
  }

  if (signals.length === 0) {
    signals.push({
      kind: "STEADY",
      detail: `No catalog or price changes observed in the last ${summary.windowDays} days`,
    });
  }

  return signals;
}
