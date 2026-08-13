import type { PrismaClient } from "@prisma/client";
import { REVIEW_APP_KEYS } from "../growth/review-infrastructure";

/**
 * Bounded, provider-aware candidate selection for storefront JSON-LD review
 * sampling (Milestone 9 Sub-phase E). Deliberately mirrors
 * growth/report.ts's selectHighlightProducts() — "ranked bestsellers first,
 * then most-recently-seen fill the rest" — rather than inventing a second
 * selection strategy, per Step 4/Step 0's explicit "reuse the already-shipped
 * bestseller product set" instruction.
 *
 * Provider detection is a BUDGET hint, never a gate: Milestone 9 Sub-phase D
 * found real JSON-LD adoption even on stores with no detected review app
 * (tarte.com, an unexplained but real positive), so a no-provider store is
 * still sampled — just with a smaller budget, since the evidence (100%
 * store-level adoption on Okendo-detected stores vs 16.7% on no-provider
 * stores) says the larger budget is far more likely to pay off there.
 */

/** With a detected review provider — matches the brief's own suggested default exactly. */
export const MAX_REVIEW_OBSERVATION_PRODUCTS = 20;
/** No review provider detected on the store at all — smaller, not zero: Sub-phase D's tarte.com outlier is real evidence a positive result is still possible. */
export const MAX_REVIEW_OBSERVATION_PRODUCTS_NO_PROVIDER = 5;

export interface ReviewSampleCandidate {
  id: string;
  externalId: string;
  handle: string;
}

export interface ReviewSampleSelection {
  candidates: ReviewSampleCandidate[];
  /** Review-app keys (review-infrastructure.ts's REVIEW_APP_KEYS) detected ACTIVE on this store right now, if any. */
  detectedProviders: string[];
  budget: number;
}

async function detectReviewProviders(prisma: PrismaClient, storeId: string): Promise<string[]> {
  const rows = await prisma.storeEntity.findMany({
    where: { storeId, kind: "APP", key: { in: [...REVIEW_APP_KEYS] }, status: "ACTIVE" },
    select: { key: true },
  });
  return rows.map((r) => r.key);
}

/**
 * PURE selection logic, decoupled from the DB read above so it stays as
 * directly testable as bestseller.ts's own computeBestsellerSignal().
 */
export function chooseReviewBudget(detectedProviders: string[]): number {
  return detectedProviders.length > 0 ? MAX_REVIEW_OBSERVATION_PRODUCTS : MAX_REVIEW_OBSERVATION_PRODUCTS_NO_PROVIDER;
}

export async function selectReviewSampleCandidates(
  prisma: PrismaClient,
  storeId: string,
): Promise<ReviewSampleSelection> {
  const detectedProviders = await detectReviewProviders(prisma, storeId);
  const budget = chooseReviewBudget(detectedProviders);

  const select = { id: true, externalId: true, handle: true } as const;

  const ranked = await prisma.product.findMany({
    where: { storeId, status: "ACTIVE", bestsellerRank: { not: null } },
    orderBy: { bestsellerRank: "asc" },
    take: budget,
    select,
  });

  let candidates: ReviewSampleCandidate[] = ranked;
  if (candidates.length < budget) {
    const remainingSlots = budget - candidates.length;
    const excludeIds = candidates.map((c) => c.id);
    const recent = await prisma.product.findMany({
      where: { storeId, status: "ACTIVE", ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}) },
      orderBy: { firstSeenAt: "desc" },
      take: remainingSlots,
      select,
    });
    candidates = [...candidates, ...recent];
  }

  return { candidates, detectedProviders, budget };
}
