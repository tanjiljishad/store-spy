import type { PrismaClient } from "@prisma/client";

/**
 * Store-level catalog-size-over-time, reconstructed entirely from
 * Product.firstSeenAt/missingSince — no new table, no per-date query.
 *
 * A product existed at time T iff firstSeenAt <= T and it wasn't yet missing
 * at T (missingSince is null, or missingSince > T). Walking this for a
 * handful of sampled dates gives the exact step-function catalog size at
 * each point, using data every crawl already writes.
 *
 * Two bounded queries only, regardless of store age or catalog size:
 *   1. The store's most recent MAX_CRAWLS_FOR_TREND real crawl dates.
 *   2. Every product's (firstSeenAt, missingSince), capped defensively.
 * All date-sampling and size computation happens in memory from those two
 * results — never one query per plotted point.
 *
 * Honest limitation (documented, not hidden): a product added and fully
 * removed entirely between two crawls is invisible to this reconstruction —
 * see docs/milestone-5-growth-signals-research.md Section 3.3/7.3. This
 * makes the trend a lower bound on real catalog churn, not an exact ledger.
 *
 * Below MIN_CRAWLS_FOR_CATALOG_TREND real crawls, sampling at real crawl
 * dates alone isn't rich enough to be worth showing — but a single crawl
 * already gives every current product's OWN Shopify creation date
 * (`Product.sourceCreatedAt`, parsed from `/products.json`'s `created_at`
 * — see diff/engine.ts's baseline handling, which backdates each product's
 * `PRODUCT_ADDED` event the same way). `getCatalogGrowthTrend` falls back to
 * reconstructing the curve from those launch dates instead of waiting for
 * more crawls: `catalogSizeAt` treats a product as existing from
 * `sourceCreatedAt ?? firstSeenAt`, so a store analyzed for the first time
 * today can still show its catalog's growth back to when each visible
 * product actually launched — not just a flat step at "today." Same honest
 * limitation applies, one layer earlier: a product added AND fully removed
 * before the first crawl is invisible either way, since no Product row for
 * it ever existed to record a sourceCreatedAt from.
 *
 * CRITICAL: sample dates are `Crawl.finishedAt`, never `startedAt`. Both
 * `firstSeenAt` and `missingSince` are written from the same `now` value used
 * for that crawl's `finishedAt` (see diff/persist.ts); `startedAt` is set
 * separately, before the storefront fetch begins, and is always strictly
 * earlier. Sampling `startedAt` would misclassify the exact crawl that
 * discovered a product — a newly-added product would appear absent at its
 * own discovery date, and a newly-removed one would still count as present
 * at the crawl that confirmed it gone. See persistence.ts's module doc for
 * the full explanation — this module has the identical failure mode.
 */

export const MAX_CRAWLS_FOR_TREND = 180;
export const MAX_CATALOG_TREND_POINTS = 12;
export const MIN_CRAWLS_FOR_CATALOG_TREND = 3;
const MAX_PRODUCTS_FOR_CATALOG_HISTORY = 20_000;

export interface CatalogTrendPoint {
  at: Date;
  size: number;
}

export interface CatalogTrendInsufficientHistory {
  status: "INSUFFICIENT_HISTORY";
  realCrawlsAvailable: number;
}

export interface CatalogTrendObserved {
  status: "OBSERVED";
  points: CatalogTrendPoint[];
  /** How many real crawls the trend was sampled from (bounded by MAX_CRAWLS_FOR_TREND). */
  sampledFromCrawlCount: number;
  /**
   * True when the curve was reconstructed from products' own Shopify launch
   * dates (possible from a single crawl) rather than sampled across
   * multiple real crawl snapshots. A reconstructed curve can go further
   * back in time than this store has actually been monitored, but — like
   * the real-crawl-sampled curve — cannot show a product that was added
   * and fully removed before the crawl(s) it was built from.
   */
  reconstructedFromLaunchDates: boolean;
}

export type CatalogTrendResult = CatalogTrendInsufficientHistory | CatalogTrendObserved;

/** Evenly-spaced index sampling — always includes the first and last item. */
export function sampleEvenly<T>(itemsAscending: T[], maxPoints: number): T[] {
  if (maxPoints <= 0 || itemsAscending.length === 0) return [];
  if (itemsAscending.length <= maxPoints) return itemsAscending;
  if (maxPoints === 1) return [itemsAscending[itemsAscending.length - 1]];

  const step = (itemsAscending.length - 1) / (maxPoints - 1);
  const sampled: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(itemsAscending[Math.round(i * step)]);
  }
  return sampled.filter((item, i) => i === 0 || item !== sampled[i - 1]);
}

export interface CatalogProductInput {
  firstSeenAt: Date;
  missingSince: Date | null;
  /** Shopify's own created_at for this product, when known — see this module's doc comment. */
  sourceCreatedAt?: Date | null;
}

export function catalogSizeAt(products: CatalogProductInput[], at: Date): number {
  const atMs = at.getTime();
  let count = 0;
  for (const p of products) {
    const existedFrom = p.sourceCreatedAt ?? p.firstSeenAt;
    if (existedFrom.getTime() > atMs) continue;
    if (p.missingSince !== null && p.missingSince.getTime() <= atMs) continue;
    count++;
  }
  return count;
}

/** PURE. Evenly spaced Date samples from start to end inclusive (both endpoints always included). */
export function evenlySpacedDates(start: Date, end: Date, maxPoints: number): Date[] {
  if (maxPoints <= 0 || start.getTime() > end.getTime()) return [];
  if (maxPoints === 1 || start.getTime() === end.getTime()) return [end];

  const startMs = start.getTime();
  const step = (end.getTime() - startMs) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => new Date(startMs + step * i));
}

/** PURE. crawlDates in any order; products already fetched and bounded by the caller. */
export function buildCatalogTrend(
  crawlDates: Date[],
  products: CatalogProductInput[],
  maxPoints: number,
): CatalogTrendPoint[] {
  const ascending = [...crawlDates].sort((a, b) => a.getTime() - b.getTime());
  const sampledDates = sampleEvenly(ascending, maxPoints);
  return sampledDates.map((at) => ({ at, size: catalogSizeAt(products, at) }));
}

export async function getCatalogGrowthTrend(
  prisma: PrismaClient,
  storeId: string,
  opts: { maxPoints?: number } = {},
): Promise<CatalogTrendResult> {
  const maxPoints = opts.maxPoints ?? MAX_CATALOG_TREND_POINTS;

  const crawlRows = await prisma.crawl.findMany({
    where: { storeId, status: { in: ["OK", "PARTIAL"] }, finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: MAX_CRAWLS_FOR_TREND,
    select: { finishedAt: true },
  });

  if (crawlRows.length === 0) {
    return { status: "INSUFFICIENT_HISTORY", realCrawlsAvailable: 0 };
  }

  const productRows = await prisma.product.findMany({
    where: { storeId },
    select: { firstSeenAt: true, missingSince: true, sourceCreatedAt: true },
    take: MAX_PRODUCTS_FOR_CATALOG_HISTORY,
  });

  if (crawlRows.length >= MIN_CRAWLS_FOR_CATALOG_TREND) {
    const points = buildCatalogTrend(
      // finishedAt is guaranteed non-null by the where clause — see persistence.ts's identical pattern.
      crawlRows.map((c) => c.finishedAt as Date),
      productRows,
      maxPoints,
    );
    return { status: "OBSERVED", points, sampledFromCrawlCount: crawlRows.length, reconstructedFromLaunchDates: false };
  }

  // Fewer than MIN_CRAWLS_FOR_CATALOG_TREND real crawls — reconstruct from
  // each visible product's own Shopify launch date instead of making the
  // user wait for more crawls. See this module's doc comment.
  const earliestLaunch = productRows.reduce<Date | null>((min, p) => {
    if (!p.sourceCreatedAt) return min;
    return min === null || p.sourceCreatedAt < min ? p.sourceCreatedAt : min;
  }, null);

  if (earliestLaunch === null) {
    // No product here carries a launch date at all (e.g. a non-Shopify
    // source, or a store with zero currently-visible products) — nothing
    // to reconstruct from, so fall back to the honest "not enough yet".
    return { status: "INSUFFICIENT_HISTORY", realCrawlsAvailable: crawlRows.length };
  }

  const mostRecentCrawl = crawlRows[0].finishedAt as Date; // crawlRows is ORDER BY finishedAt desc
  const sampleDates = evenlySpacedDates(earliestLaunch, mostRecentCrawl, maxPoints);
  const points = sampleDates.map((at) => ({ at, size: catalogSizeAt(productRows, at) }));

  return { status: "OBSERVED", points, sampledFromCrawlCount: crawlRows.length, reconstructedFromLaunchDates: true };
}
