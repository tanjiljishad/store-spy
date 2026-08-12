import type { IntelligenceField, ObservedField, UnavailableField } from "../analysis/report-contract";
import type { MonitoringStatus } from "../analysis/types";
import type { Limit } from "../entitlements/plan-limits";
import type { GrowthSignal } from "../monitoring/activity";
import type { CatalogTrendResult } from "../growth/catalog";
import type { ProductHighlight } from "../growth/report";
import type { ReviewInfrastructureEntry } from "../growth/review-infrastructure";
import type { MarketingReport } from "../marketing/report";

/**
 * The canonical Store Intelligence contract (Milestone 7 Sub-phase B).
 *
 * This is a COMPOSITION type, not a new calculation: every field here is
 * produced by an existing, already-tested domain module
 * (analysis/run-analysis.ts, growth/report.ts, marketing/report.ts). See
 * intelligence/report.ts for the composer that assembles it, and
 * docs/milestone-7-subphase-b-completion-report.md for exactly which
 * existing function backs which section.
 *
 * Section boundaries (documented once, here, since they're a judgment call
 * this milestone's brief left to the implementer):
 *   - identity/technology/catalog: static-ish "what is this store" facts,
 *     sourced from buildFullStoreReport()'s existing queries.
 *   - growth: store-level activity + the catalog-size trend over time —
 *     literally growth/report.ts's own CatalogGrowthView, unchanged.
 *   - productIntelligence: the bounded, per-product highlight list —
 *     literally growth/report.ts's own productHighlights, unchanged.
 *   - marketing: growth/report.ts's sibling, marketing/report.ts's
 *     MarketingReport, passed through whole — no restructuring, since its
 *     own shape is already correct and already tested.
 *   - reviews: review-infrastructure presence (from the growth report) PLUS
 *     the permanent reviewVelocity UNAVAILABLE placeholder, grouped together
 *     because both are about the same topic even though they come from two
 *     different upstream calls.
 *   - commercial: revenue/traffic, kept exactly as UNAVAILABLE as they've
 *     always been (Milestone 5/6) — grouped separately from "reviews" only
 *     because revenue/traffic aren't reviews-specific.
 *   - monitoring/entitlement: passed through from buildFullStoreReport()
 *     unchanged.
 *   - meta: report-level bookkeeping (when it was generated, whether each
 *     section had enough history) — deliberately NOT a confidence score.
 *     See Section 11/22 of the Sub-phase A research doc for why no such
 *     score is computed anywhere in this file.
 */

export interface StoreIdentitySection {
  domain: string;
  platform: "shopify";
  theme: IntelligenceField<{ name: string | null; version: string | null }>;
}

export interface TechnologySection {
  apps: IntelligenceField<string[]>;
  pixels: IntelligenceField<string[]>;
  paymentProviders: IntelligenceField<string[]>;
}

export interface CatalogSection {
  productCount: IntelligenceField<number>;
  averagePrice: IntelligenceField<number>;
}

/** Store-level activity + the catalog-size trend — growth/report.ts's CatalogGrowthView, unchanged. */
export interface GrowthSection {
  windowDays: number;
  productsAdded: number;
  productsRemoved: number;
  productsRestored: number;
  productCountDelta: number | null;
  currentProductCount: number;
  hasEnoughHistory: boolean;
  signals: GrowthSignal[];
  trend: CatalogTrendResult;
}

/** The bounded, per-product highlight list — growth/report.ts's productHighlights, unchanged. */
export interface ProductIntelligenceSection {
  highlights: ProductHighlight[];
}

export interface ReviewsSection {
  infrastructure: ObservedField<ReviewInfrastructureEntry[]> | UnavailableField;
  /**
   * Permanent — see Milestone 5 Sub-phase A / Milestone 6 Sub-phase A. Never
   * computed from infrastructure presence. Keeps FullStoreReport's original
   * value shape (reviewsPerMonth), matching IntelligenceCard's existing
   * format-callback convention, even though the only value ever produced
   * today is UNAVAILABLE — see report.ts's asPermanentlyUnavailable().
   */
  velocity: IntelligenceField<{ reviewsPerMonth: number }>;
}

export interface CommercialSection {
  /** Permanent — see Milestone 5 Sub-phase A. No validated model exists. Value shape reserved for a future validated estimate, never populated today. */
  revenue: IntelligenceField<{ minCents: number; maxCents: number }>;
  /** Permanent — see Milestone 5 Sub-phase A. No reliable, affordable, corpus-accurate source exists. */
  traffic: IntelligenceField<{ monthlyVisits: number }>;
}

export interface ReportMeta {
  generatedAt: string;
  /**
   * Per-section history sufficiency — NOT a confidence score. A store can
   * be hasEnoughHistory:true for growth and false for marketing at the same
   * time (they're independent pipelines with independent baselines); this
   * object exists so a UI/API consumer can ask "is THIS section's history
   * sufficient" without inferring it from unrelated fields.
   */
  historySufficiency: {
    growth: boolean;
    marketing: boolean;
  };
}

export interface StoreIntelligenceReport {
  domain: string;
  identity: StoreIdentitySection;
  technology: TechnologySection;
  catalog: CatalogSection;
  productIntelligence: ProductIntelligenceSection;
  growth: GrowthSection;
  marketing: MarketingReport;
  reviews: ReviewsSection;
  commercial: CommercialSection;
  monitoring: MonitoringStatus;
  entitlement: { analysesUsed: number; analysesLimit: Limit; alreadyAnalyzed: boolean };
  meta: ReportMeta;
}
