import type { PrismaClient } from "@prisma/client";
import {
  permanentlyUnavailable,
  type IntelligenceField,
  type UnavailableField,
} from "../analysis/report-contract";
import { buildFullStoreReport } from "../analysis/run-analysis";
import type { PlanTier } from "../entitlements/plan-limits";
import { buildGrowthReport } from "../growth/report";
import { buildMarketingReport } from "../marketing/report";
import { domainRegisteredAtField, firstArchivedAtField } from "../enrichment/domain-age";
import type { StoreIntelligenceReport } from "./types";

/**
 * The Store Intelligence Composer (Milestone 7 Sub-phase B).
 *
 * Pure composition: calls three already-existing, already-tested report
 * builders concurrently and reshapes their output into one canonical,
 * sectioned contract. Computes NOTHING itself — every value here traces to
 * a query that already existed before this file was written. See
 * intelligence/types.ts for the section-boundary rationale.
 *
 * Deterministic: given the same underlying database state, this returns the
 * same report — every upstream call it makes (buildFullStoreReport,
 * buildGrowthReport, buildMarketingReport) is itself a deterministic read,
 * confirmed by direct inspection of each (no caching, no randomness, no
 * wall-clock-dependent branching beyond "what time is it right now" for
 * `checkedAt`/`generatedAt` timestamp fields, which is the same convention
 * every existing report builder in this codebase already uses).
 *
 * Deliberately NOT wired into the synchronous crawl-triggering analyze path
 * (run-analysis.ts's runAnalysis()) — that is the one path this project has
 * spent three milestones protecting from added per-request cost (BASIC's
 * unlimited analyses have no cost ceiling). This composer is for REVISIT
 * flows only: GET /api/store/[domain]/report and the dashboard Store
 * Intelligence page, both of which read already-persisted data with no new
 * crawl. See the Sub-phase B completion report's Query/Performance section.
 */
export async function buildStoreIntelligenceReport(
  prisma: PrismaClient,
  storeId: string,
  domain: string,
  userId: string,
  alreadyAnalyzed: boolean,
): Promise<StoreIntelligenceReport> {
  const [full, growth, marketing, domainAge] = await Promise.all([
    buildFullStoreReport(prisma, storeId, domain, userId, alreadyAnalyzed),
    buildGrowthReport(prisma, storeId, domain),
    buildMarketingReport(prisma, storeId, domain),
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { domainRegisteredAt: true, firstArchivedAt: true },
    }),
  ]);

  return {
    domain,
    identity: {
      domain,
      platform: "shopify",
      theme: full.theme,
      domainRegisteredAt: domainRegisteredAtField({
        domainRegisteredAt: domainAge.domainRegisteredAt,
        firstArchivedAt: domainAge.firstArchivedAt,
      }),
      firstArchivedAt: firstArchivedAtField({
        domainRegisteredAt: domainAge.domainRegisteredAt,
        firstArchivedAt: domainAge.firstArchivedAt,
      }),
    },
    technology: {
      apps: full.apps,
      pixels: full.pixels,
      paymentProviders: full.paymentProviders,
    },
    catalog: {
      productCount: full.productCount,
      averagePrice: full.averagePrice,
    },
    productIntelligence: {
      highlights: growth.productHighlights,
    },
    growth: growth.catalogGrowth,
    marketing,
    reviews: {
      infrastructure: growth.reviewInfrastructure,
      velocity: asPermanentlyUnavailable(full.reviewVelocity, "Review history is not yet reliably collected"),
      coverage: growth.reviewCoverage,
    },
    commercial: {
      revenue: asPermanentlyUnavailable(full.revenue, "No validated revenue model implemented yet"),
      traffic: asPermanentlyUnavailable(full.traffic, "No validated traffic estimation model implemented yet"),
    },
    monitoring: full.monitoring,
    entitlement: full.entitlement,
    meta: {
      generatedAt: new Date().toISOString(),
      historySufficiency: {
        growth: growth.catalogGrowth.hasEnoughHistory,
        marketing: marketing.activity?.hasEnoughHistory ?? false,
      },
    },
  };
}

export type { PlanTier };

/**
 * revenue/traffic/reviewVelocity are hardcoded UNAVAILABLE constants inside
 * buildFullStoreReport() today (never anything else) — this narrows the
 * wider IntelligenceField<T> type down to the UnavailableField this
 * composer's contract promises, falling back to a fresh reason string only
 * in the (currently unreachable) case that ever changes upstream, so this
 * composer never silently ships a fabricated commercial/reviews value.
 *
 * Always marks the result `permanent: true` — these three are not "not
 * built yet," they're a deliberate, researched NO-GO (see
 * docs/milestone-5-revenue-traffic-research.md's decision gate), and the
 * card should say so rather than implying they're merely upcoming.
 */
function asPermanentlyUnavailable<T>(field: IntelligenceField<T>, fallbackReason: string): UnavailableField {
  return field.status === "UNAVAILABLE" ? { ...field, permanent: true } : permanentlyUnavailable(fallbackReason);
}
