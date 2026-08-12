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
}

export function catalogSizeAt(products: CatalogProductInput[], at: Date): number {
  const atMs = at.getTime();
  let count = 0;
  for (const p of products) {
    if (p.firstSeenAt.getTime() > atMs) continue;
    if (p.missingSince !== null && p.missingSince.getTime() <= atMs) continue;
    count++;
  }
  return count;
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

  if (crawlRows.length < MIN_CRAWLS_FOR_CATALOG_TREND) {
    return { status: "INSUFFICIENT_HISTORY", realCrawlsAvailable: crawlRows.length };
  }

  const productRows = await prisma.product.findMany({
    where: { storeId },
    select: { firstSeenAt: true, missingSince: true },
    take: MAX_PRODUCTS_FOR_CATALOG_HISTORY,
  });

  const points = buildCatalogTrend(
    // finishedAt is guaranteed non-null by the where clause — see persistence.ts's identical pattern.
    crawlRows.map((c) => c.finishedAt as Date),
    productRows,
    maxPoints,
  );

  return { status: "OBSERVED", points, sampledFromCrawlCount: crawlRows.length };
}
