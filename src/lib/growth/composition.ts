import type { PrismaClient } from "@prisma/client";

/**
 * Catalog composition — price spread, discount depth, vendor mix, and
 * product-type mix for a store's CURRENT active catalog. Every input here
 * (`priceMinCents`, `priceMaxCents`, `compareAtMaxCents`, `vendor`,
 * `productType`) is a column this codebase already writes on every crawl
 * (see diff/persist.ts) — this module adds no new crawl surface, only a
 * new read over data that already exists. Consistent with averagePrice
 * elsewhere in this codebase (run-analysis.ts): `priceMinCents` is "the"
 * price for a product with multiple variants.
 *
 * A snapshot of the CURRENT catalog only, not a trend over time — unlike
 * catalog.ts's growth curve, there is no historical "composition on date
 * X" reconstruction here, since compare-at prices and vendor/type
 * assignments are current-state fields (like theme or apps), not append-only
 * history.
 */

const MAX_MIX_ENTRIES = 8;
const MIN_PRODUCTS_FOR_COMPOSITION = 1;

export interface PriceSpread {
  minCents: number;
  maxCents: number;
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
}

export interface DiscountDepth {
  discountedCount: number;
  totalCount: number;
  /** Mean of (compareAt - price) / compareAt across discounted products only, as a whole-number percent. Null when nothing is discounted. */
  averageDiscountPercent: number | null;
}

export interface MixEntry {
  label: string;
  count: number;
}

export interface CatalogCompositionObserved {
  status: "OBSERVED";
  priceSpread: PriceSpread;
  discountDepth: DiscountDepth;
  /** Top vendors by product count, capped at MAX_MIX_ENTRIES — never every vendor for a large catalog. */
  vendorMix: MixEntry[];
  /** Top product types by product count, capped at MAX_MIX_ENTRIES. */
  productTypeMix: MixEntry[];
  productCount: number;
}

export interface CatalogCompositionUnavailable {
  status: "UNAVAILABLE";
  reason: string;
}

export type CatalogCompositionResult = CatalogCompositionObserved | CatalogCompositionUnavailable;

export interface CompositionProductInput {
  priceMinCents: number;
  compareAtMaxCents: number | null;
  vendor: string | null;
  productType: string | null;
}

/** PURE. Nearest-rank percentile over already-sorted-ascending cents values. */
function percentile(sortedAscending: number[], p: number): number {
  const index = Math.min(sortedAscending.length - 1, Math.floor(p * sortedAscending.length));
  return sortedAscending[index];
}

function topEntries(counts: Map<string, number>, max: number): MixEntry[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([label, count]) => ({ label, count }));
}

/** PURE. products must be non-empty — caller (getCatalogComposition) handles the empty case. */
export function computeCatalogComposition(products: CompositionProductInput[]): CatalogCompositionObserved {
  const prices = products.map((p) => p.priceMinCents).sort((a, b) => a - b);

  const discounted = products.filter((p) => p.compareAtMaxCents !== null && p.compareAtMaxCents > p.priceMinCents);
  const averageDiscountPercent =
    discounted.length > 0
      ? Math.round(
          (discounted.reduce((sum, p) => sum + (p.compareAtMaxCents! - p.priceMinCents) / p.compareAtMaxCents!, 0) /
            discounted.length) *
            100,
        )
      : null;

  const vendorCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const p of products) {
    if (p.vendor) vendorCounts.set(p.vendor, (vendorCounts.get(p.vendor) ?? 0) + 1);
    if (p.productType) typeCounts.set(p.productType, (typeCounts.get(p.productType) ?? 0) + 1);
  }

  return {
    status: "OBSERVED",
    priceSpread: {
      minCents: prices[0],
      maxCents: prices[prices.length - 1],
      medianCents: percentile(prices, 0.5),
      p25Cents: percentile(prices, 0.25),
      p75Cents: percentile(prices, 0.75),
    },
    discountDepth: { discountedCount: discounted.length, totalCount: products.length, averageDiscountPercent },
    vendorMix: topEntries(vendorCounts, MAX_MIX_ENTRIES),
    productTypeMix: topEntries(typeCounts, MAX_MIX_ENTRIES),
    productCount: products.length,
  };
}

export async function getCatalogComposition(prisma: PrismaClient, storeId: string): Promise<CatalogCompositionResult> {
  const products = await prisma.product.findMany({
    where: { storeId, status: "ACTIVE" },
    select: { priceMinCents: true, compareAtMaxCents: true, vendor: true, productType: true },
  });

  if (products.length < MIN_PRODUCTS_FOR_COMPOSITION) {
    return { status: "UNAVAILABLE", reason: "No active products to summarize yet." };
  }

  return computeCatalogComposition(products);
}
