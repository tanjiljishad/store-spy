import type { PrismaClient } from "@prisma/client";
import type { ObservedField, UnavailableField } from "../analysis/report-contract";
import { computeGrowthSignals, getActivitySummary, type ActivitySummary, type GrowthSignal } from "../monitoring/activity";
import { getCatalogGrowthTrend, type CatalogTrendResult } from "./catalog";
import { getCatalogComposition, type CatalogCompositionResult } from "./composition";
import { getReviewInfrastructureSignal, type ReviewInfrastructureEntry } from "./review-infrastructure";
import { getFreshnessSignal, type FreshnessSignal } from "./freshness";
import { getBestsellerSignal, type BestsellerSignal } from "./bestseller";
import {
  getReviewObservationSignal,
  getReviewCoverageSummary,
  type ReviewObservationSignal,
  type ReviewCoverageSummary,
} from "../reviews/signal";

/**
 * Growth signals — an additive, store-scoped report, deliberately NOT merged
 * into FullStoreReport (analysis/types.ts), same reasoning as
 * marketing/report.ts: that type drives the existing Fable UI, and this
 * sub-phase must not touch it. No entitlement gate — matches the marketing
 * route's precedent (Milestone 4C: new intelligence categories are open to
 * every analyzed user, not gated behind the unused advancedIntelligence
 * capability).
 *
 * Every signal here is OBSERVED or UNAVAILABLE — never a fabricated
 * ESTIMATED just to fill out the UI (see report-contract.ts).
 */

/** Hard, unconditional ceiling: never scales with catalog size, regardless of how large a store's catalog grows. */
export const MAX_PRODUCT_HIGHLIGHTS = 20;

export interface CatalogGrowthView {
  windowDays: number;
  productsAdded: number;
  productsRemoved: number;
  productsRestored: number;
  /**
   * Added Milestone 7 Sub-phase D — was already computed by getActivitySummary()
   * but not previously exposed here, which is why StoreActivitySummary.tsx kept
   * its own separate /activity fetch instead of being seedable from this report.
   */
  priceChanges: number;
  productCountDelta: number | null;
  currentProductCount: number;
  hasEnoughHistory: boolean;
  signals: GrowthSignal[];
  trend: CatalogTrendResult;
  /**
   * Current-catalog snapshot (price spread, discount depth, vendor/type
   * mix) — a single, no-history-required read, unlike `trend`. See
   * composition.ts.
   */
  composition: CatalogCompositionResult;
}

export interface ProductHighlight {
  productId: string;
  handle: string;
  title: string;
  freshness: FreshnessSignal;
  bestseller: BestsellerSignal;
  /**
   * Milestone 9 Sub-phase E — bounded storefront JSON-LD review-count
   * sample, product-level only. NOT present for every highlighted product:
   * only the ones actually included in that crawl's bounded sample (see
   * reviews/sampling.ts) carry anything beyond NOT_SAMPLED.
   */
  reviewObservation: ReviewObservationSignal;
}

export interface GrowthReport {
  domain: string;
  checkedAt: string;
  catalogGrowth: CatalogGrowthView;
  reviewInfrastructure: ObservedField<ReviewInfrastructureEntry[]> | UnavailableField;
  productHighlights: ProductHighlight[];
  /**
   * SAMPLE coverage, never a store-wide review total — see reviews/signal.ts's
   * own doc comment. "8 of 20 sampled products exposed a review count" is a
   * fact about the sample, not a fact about the store's real review inventory.
   */
  reviewCoverage: ReviewCoverageSummary;
}

interface HighlightProductRow {
  id: string;
  externalId: string;
  handle: string;
  title: string;
  firstSeenAt: Date;
  missingSince: Date | null;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  bestsellerRank: number | null;
}

/**
 * Ranked products first (most interesting — real, observable movement to
 * show), then most-recently-discovered/changed products fill any remaining
 * slots. Always capped at MAX_PRODUCT_HIGHLIGHTS regardless of catalog size.
 */
async function selectHighlightProducts(prisma: PrismaClient, storeId: string): Promise<HighlightProductRow[]> {
  const select = {
    id: true,
    externalId: true,
    handle: true,
    title: true,
    firstSeenAt: true,
    missingSince: true,
    status: true,
    bestsellerRank: true,
  } as const;

  const ranked = await prisma.product.findMany({
    where: { storeId, status: "ACTIVE", bestsellerRank: { not: null } },
    orderBy: { bestsellerRank: "asc" },
    take: MAX_PRODUCT_HIGHLIGHTS,
    select,
  });

  if (ranked.length >= MAX_PRODUCT_HIGHLIGHTS) return ranked;

  const remainingSlots = MAX_PRODUCT_HIGHLIGHTS - ranked.length;
  const excludeIds = ranked.map((r) => r.id);
  const recent = await prisma.product.findMany({
    where: { storeId, status: "ACTIVE", ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}) },
    orderBy: { firstSeenAt: "desc" },
    take: remainingSlots,
    select,
  });

  return [...ranked, ...recent];
}

export async function buildGrowthReport(prisma: PrismaClient, storeId: string, domain: string): Promise<GrowthReport> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { baselinedAt: true } });

  const [activitySummary, trend, composition, reviewInfrastructure, highlightProducts, reviewCoverage] =
    await Promise.all([
      getActivitySummary(prisma, storeId),
      getCatalogGrowthTrend(prisma, storeId),
      getCatalogComposition(prisma, storeId),
      getReviewInfrastructureSignal(prisma, storeId, store.baselinedAt),
      selectHighlightProducts(prisma, storeId),
      getReviewCoverageSummary(prisma, storeId),
    ]);

  // Bounded, fixed-size fan-out: MAX_PRODUCT_HIGHLIGHTS products, each a
  // constant number of already-bounded queries (see persistence.ts/
  // bestseller.ts) — never scales with total catalog size. Run concurrently
  // to keep wall-clock latency flat rather than proportional to the count.
  const productHighlights = await Promise.all(
    highlightProducts.map(async (p): Promise<ProductHighlight> => {
      const [freshness, bestseller, reviewObservation] = await Promise.all([
        getFreshnessSignal(prisma, storeId, {
          externalId: p.externalId,
          firstSeenAt: p.firstSeenAt,
          missingSince: p.missingSince,
          status: p.status,
        }),
        getBestsellerSignal(prisma, { id: p.id, bestsellerRank: p.bestsellerRank }),
        getReviewObservationSignal(prisma, p.id),
      ]);
      return { productId: p.id, handle: p.handle, title: p.title, freshness, bestseller, reviewObservation };
    }),
  );

  return {
    domain,
    checkedAt: new Date().toISOString(),
    catalogGrowth: buildCatalogGrowthView(activitySummary, trend, composition),
    reviewInfrastructure,
    productHighlights,
    reviewCoverage,
  };
}

function buildCatalogGrowthView(
  summary: ActivitySummary,
  trend: CatalogTrendResult,
  composition: CatalogCompositionResult,
): CatalogGrowthView {
  return {
    windowDays: summary.windowDays,
    productsAdded: summary.productsAdded,
    productsRemoved: summary.productsRemoved,
    productsRestored: summary.productsRestored,
    priceChanges: summary.priceChanges,
    productCountDelta: summary.productCountDelta,
    currentProductCount: summary.currentProductCount,
    hasEnoughHistory: summary.hasEnoughHistory,
    signals: computeGrowthSignals(summary),
    trend,
    composition,
  };
}
