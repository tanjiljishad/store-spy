import type { PrismaClient } from "@prisma/client";

/**
 * Read-time review-observation signal — mirrors growth/bestseller.ts's own
 * shape exactly (computeBestsellerSignal / getBestsellerSignal): a PURE
 * function over already-fetched rows, plus a thin bounded-query wrapper.
 * Never fabricates a value: a product that was never sampled gets
 * NOT_SAMPLED, one that was sampled but exposed nothing gets UNSUPPORTED,
 * and a missing PRIOR observation never becomes a fabricated "0 -> N" delta
 * (Step 8: "unknown -> 231. This is NOT 0 -> 231.").
 *
 * Hard language rule enforced by construction, not by convention: this
 * module computes a COUNT and a DELTA between two counts. It never computes
 * or exposes a rate, a velocity, or anything resembling
 * reviews-per-time-period — see docs/milestone-9-*.md, Milestone 5's
 * permanent revenue/review-velocity DO-NOT-BUILD.
 */

export const MAX_REVIEW_OBSERVATIONS_QUERIED = 10;

export interface ReviewObservationRow {
  reviewCount: number | null;
  ratingValue: number | null;
  observedAt: Date;
  sharedWithGroup: boolean;
}

export type ReviewObservationSignal =
  | {
      status: "OBSERVED";
      reviewCount: number;
      ratingValue: number | null;
      observedAt: Date;
      sharedWithGroup: boolean;
      /** Null when there is no earlier observation with a usable count to compare against — never a fabricated 0-baseline. */
      change: { previousCount: number; delta: number } | null;
    }
  | { status: "UNSUPPORTED" }
  | { status: "NOT_SAMPLED" };

/** PURE. rowsDesc is already fetched and bounded (most-recent-first). */
export function computeReviewObservationSignal(rowsDesc: ReviewObservationRow[]): ReviewObservationSignal {
  if (rowsDesc.length === 0) return { status: "NOT_SAMPLED" };

  const latest = rowsDesc[0];
  if (latest.reviewCount === null) return { status: "UNSUPPORTED" };

  const prior = rowsDesc.slice(1).find((r) => r.reviewCount !== null);
  const change =
    prior && prior.reviewCount !== null
      ? { previousCount: prior.reviewCount, delta: latest.reviewCount - prior.reviewCount }
      : null;

  return {
    status: "OBSERVED",
    reviewCount: latest.reviewCount,
    ratingValue: latest.ratingValue,
    observedAt: latest.observedAt,
    sharedWithGroup: latest.sharedWithGroup,
    change,
  };
}

export async function getReviewObservationSignal(
  prisma: PrismaClient,
  productId: string,
): Promise<ReviewObservationSignal> {
  const rows = await prisma.storefrontReviewObservation.findMany({
    where: { productId },
    orderBy: { observedAt: "desc" },
    take: MAX_REVIEW_OBSERVATIONS_QUERIED,
    select: { reviewCount: true, ratingValue: true, observedAt: true, sharedWithGroup: true },
  });
  return computeReviewObservationSignal(rows);
}

/**
 * Store-level SAMPLE-COVERAGE summary — deliberately never a store-wide
 * review total (Step 11/26: summing sampled per-product counts is
 * prohibited outright, both because it isn't the whole catalog and because
 * Sub-phase D found sibling products can share one product-group count,
 * which summation would double-count). This reports how many of the
 * products actually SAMPLED in the most recent crawl exposed a count —
 * coverage of the sample, never coverage of the store's real review total.
 */
export type ReviewCoverageSummary =
  | { status: "OBSERVED"; sampledCount: number; observedCount: number }
  | { status: "UNSUPPORTED"; sampledCount: number }
  | { status: "NOT_SAMPLED" };

export async function getReviewCoverageSummary(
  prisma: PrismaClient,
  storeId: string,
): Promise<ReviewCoverageSummary> {
  // Reuses Crawl's existing (storeId, startedAt DESC) index — cheaper and
  // more direct than joining through Product to find "the latest crawl with
  // review rows," and the result set queried next is bounded by the
  // sampling budget (<= MAX_REVIEW_OBSERVATION_PRODUCTS) regardless.
  const latestCrawl = await prisma.crawl.findFirst({
    where: { storeId, status: { in: ["OK", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (!latestCrawl) return { status: "NOT_SAMPLED" };

  const rows = await prisma.storefrontReviewObservation.findMany({
    where: { crawlId: latestCrawl.id },
    select: { reviewCount: true },
  });
  if (rows.length === 0) return { status: "NOT_SAMPLED" };

  const observedCount = rows.filter((r) => r.reviewCount !== null).length;
  if (observedCount === 0) return { status: "UNSUPPORTED", sampledCount: rows.length };
  return { status: "OBSERVED", sampledCount: rows.length, observedCount };
}
