import type { PrismaClient } from "@prisma/client";

/**
 * Ordinal bestseller-rank movement, built entirely from ProductStateSnapshot
 * history that the diff engine already writes on every rank change (see
 * engine.ts's `stateChanged` — `hasRankData && prev.bestsellerRank !==
 * p.bestsellerRank` is one of its triggers). No new crawl, no new table.
 *
 * Language discipline (hard requirement, not a suggestion): Shopify's own
 * bestseller-ranking algorithm is opaque to this system — we only ever
 * re-observe a value Shopify computed. A rank improving is evidence of
 * *something* changing favorably; it is never reported as "sales growth,"
 * "sales increased," or "revenue increased" anywhere in this module or its
 * callers. See docs/milestone-5-growth-signals-research.md Section 5.
 */

export const MAX_RANK_SNAPSHOTS = 20;
export const MIN_OBSERVATIONS_FOR_MOMENTUM = 4;
export const MIN_CRAWLS_FOR_MOMENTUM = 3;

export interface RankObservation {
  capturedAt: Date;
  rank: number | null;
  crawlId: string;
}

export interface RankMovement {
  previousRank: number;
  currentRank: number;
  /** previousRank - currentRank. Positive means the rank improved (climbed). */
  delta: number;
}

export type MomentumDirection = "IMPROVING" | "DECLINING" | "STABLE";

export interface BestsellerSignal {
  currentRank: number | null;
  /** Chronological (oldest first), ranked observations only — never a fabricated point between two real snapshots. */
  trajectory: Array<{ capturedAt: Date; rank: number }>;
  /** Null when there is no prior distinct rank observation to compare against. */
  movement: RankMovement | null;
  /**
   * Set only once MIN_OBSERVATIONS_FOR_MOMENTUM ranked observations exist
   * across MIN_CRAWLS_FOR_MOMENTUM distinct crawls, AND the trend doesn't
   * reverse direction within that window. A reversal (e.g. #40 -> #20 ->
   * #35) is deliberately reported as no momentum (null) rather than forcing
   * a direction on a trend that isn't actually clean.
   */
  momentum: MomentumDirection | null;
}

function classifyMomentum(ranksChronological: number[]): MomentumDirection | null {
  if (ranksChronological.length < MIN_OBSERVATIONS_FOR_MOMENTUM) return null;

  let sawImprovement = false; // rank number decreased (better position)
  let sawDecline = false; // rank number increased (worse position)
  for (let i = 1; i < ranksChronological.length; i++) {
    if (ranksChronological[i] < ranksChronological[i - 1]) sawImprovement = true;
    else if (ranksChronological[i] > ranksChronological[i - 1]) sawDecline = true;
  }

  if (sawImprovement && sawDecline) return null; // direction reversed — not a clean trend
  if (sawImprovement) return "IMPROVING";
  if (sawDecline) return "DECLINING";
  return "STABLE";
}

/** PURE. observationsDesc is already fetched and bounded (most-recent-first). */
export function computeBestsellerSignal(currentRank: number | null, observationsDesc: RankObservation[]): BestsellerSignal {
  const rankedDesc = observationsDesc.filter((o): o is RankObservation & { rank: number } => o.rank !== null);
  const trajectory = [...rankedDesc].reverse().map((o) => ({ capturedAt: o.capturedAt, rank: o.rank }));

  let movement: RankMovement | null = null;
  if (currentRank !== null) {
    const priorDifferent = rankedDesc.find((o) => o.rank !== currentRank);
    if (priorDifferent) {
      movement = { previousRank: priorDifferent.rank, currentRank, delta: priorDifferent.rank - currentRank };
    }
  }

  const distinctCrawlCount = new Set(rankedDesc.map((o) => o.crawlId)).size;
  const momentum =
    distinctCrawlCount >= MIN_CRAWLS_FOR_MOMENTUM
      ? classifyMomentum(trajectory.map((t) => t.rank))
      : null;

  return { currentRank, trajectory, movement, momentum };
}

export interface BestsellerProductInput {
  id: string;
  bestsellerRank: number | null;
}

export async function getBestsellerSignal(
  prisma: PrismaClient,
  product: BestsellerProductInput,
): Promise<BestsellerSignal> {
  const rows = await prisma.productStateSnapshot.findMany({
    where: { productId: product.id },
    orderBy: { capturedAt: "desc" },
    take: MAX_RANK_SNAPSHOTS,
    select: { capturedAt: true, bestsellerRank: true, crawlId: true },
  });

  return computeBestsellerSignal(
    product.bestsellerRank,
    rows.map((r) => ({ capturedAt: r.capturedAt, rank: r.bestsellerRank, crawlId: r.crawlId })),
  );
}
