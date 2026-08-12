import type { PrismaClient } from "@prisma/client";
import { observed, unavailable, type ObservedField, type UnavailableField } from "../analysis/report-contract";
import { getMarketingActivitySummary, type MarketingActivitySummary } from "./activity";

/**
 * Current-state marketing intelligence for one store — a NEW, additive
 * report shape, deliberately not merged into FullStoreReport
 * (analysis/types.ts). That type is what the existing Fable-derived UI
 * renders today; extending it risks pulling marketing data into a surface
 * this sub-phase must not redesign. Event-level history (AD_DETECTED,
 * AD_REMOVED, AD_CHANGED, PRODUCT_AD_MATCHED) needs no new code at all —
 * those are ordinary Events and already flow through the existing
 * GET /api/store/[domain]/events feed.
 *
 * Follows the same OBSERVED/UNAVAILABLE discipline as report-contract.ts:
 * `ads: { status: "OBSERVED", value: [] }` means the vendor was checked and
 * genuinely found nothing. `ads: { status: "UNAVAILABLE", reason }` means
 * the check itself failed or never happened — the two must never be
 * confused (see AGENTS.md: "do not silently downgrade an unavailable
 * source into an empty result").
 */

/**
 * Sub-phase D epistemic audit (re-confirmed, no change required): the whole
 * `ads` array carries one OBSERVED/UNAVAILABLE status (we successfully
 * checked the vendor, or we didn't) — within each item, be precise about
 * WHO is asserting each fact, even though every field here is still
 * OBSERVED-tier trustworthy (deterministic, never estimated/inferred):
 *
 *   VENDOR-SUPPLIED (the fact the vendor itself asserted):
 *     externalAdId, destinationUrl, advertiserName, format
 *   SYSTEM-DERIVED (computed by this codebase, never attributed to the
 *   vendor in code or UI copy — see AdvertisingSummary.tsx's "Last checked"
 *   framing, which is explicitly about when WE polled, not a vendor claim):
 *     matchedProduct/matchConfidence (our own deterministic exact-URL match),
 *     firstSeenAt/lastSeenAt (when WE first/most-recently observed it, not
 *     the vendor's claimed campaign start/end — no source here discloses that)
 *
 * Fields that would require estimation (ad spend, impressions, conversions,
 * ROAS, revenue attribution) do not exist anywhere in this type, and must
 * not be added without a validated data source — see AGENTS.md-adjacent
 * epistemic rules and Milestone 4's own "never fabricate intelligence" rule.
 */
export interface AdView {
  externalAdId: string;
  destinationUrl: string | null;
  advertiserName: string | null;
  format: string | null;
  /**
   * Real vendor-disclosed region names (e.g. "United States") this specific
   * ad was shown in, per Sub-phase D's live verification of the ad-details
   * endpoint. Null when the vendor didn't disclose any (not the same as
   * "shown nowhere" — absence of this data is not evidence of anything).
   */
  regions: string[] | null;
  /** Null when unmatched. Carries the store's own handle/title, not just an opaque id, so the UI never needs a second lookup. */
  matchedProduct: { id: string; handle: string; title: string } | null;
  matchConfidence: "HIGH" | "MEDIUM" | "LOW" | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MarketingReport {
  domain: string;
  platform: "GOOGLE";
  /**
   * Deterministic-only: OBSERVED or UNAVAILABLE, never ESTIMATED/INFERRED —
   * narrower than the general IntelligenceField<T> union on purpose, since
   * nothing about marketing data in this sub-phase is a model output.
   */
  ads: ObservedField<AdView[]> | UnavailableField;
  /** Null only when this store has never had a marketing collection run at all. */
  lastCheckedAt: string | null;
  /**
   * Historical/derived signals (new/removed/continuously-observed ad
   * counts) — null when there's nothing to derive from yet (mirrors
   * getActivitySummary's hasEnoughHistory gate, applied one level up: no
   * successful collection at all means there's no summary to compute).
   * When present, summary.hasEnoughHistory itself gates whether the
   * detected/removed counts are meaningful — see activity.ts.
   */
  activity: MarketingActivitySummary | null;
  /**
   * Sub-phase D verified, live, across every ad format tested: SerpApi's
   * Google Ads Transparency Center API does not return a destination/
   * landing-page URL. Deterministic exact-URL product matching therefore
   * cannot be claimed as a working capability right now — this field says
   * so explicitly, once, rather than letting every ad's silently-null
   * matchedProduct imply "we checked this specific ad and it didn't match."
   * Always UNAVAILABLE until a data source that discloses destination URLs
   * is validated — see docs/milestone-4-subphase-d-completion-report.md.
   */
  productMatching: UnavailableField;
  /** Reserved shape for a future validated data source. Always UNAVAILABLE — no source for this exists today. */
  adSpend: UnavailableField;
  /** Reserved shape for a future validated data source. Always UNAVAILABLE — no source for this exists today. */
  impressions: UnavailableField;
  /** Reserved shape for a future validated data source. Always UNAVAILABLE — no source for this exists today. */
  conversions: UnavailableField;
}

// Sub-phase E: single, explicit reasons — stated once at the top level
// rather than implied per-ad. See MarketingReport's field-level doc comments.
const PRODUCT_MATCHING_UNAVAILABLE_REASON =
  "Product-level matching unavailable from the current advertising data source.";
const AD_SPEND_UNAVAILABLE_REASON = "No validated ad-spend data source is available.";
const IMPRESSIONS_UNAVAILABLE_REASON = "No validated impressions data source is available.";
const CONVERSIONS_UNAVAILABLE_REASON = "No validated conversion data source is available.";

export async function buildMarketingReport(
  prisma: PrismaClient,
  storeId: string,
  domain: string,
): Promise<MarketingReport> {
  const lastRun = await prisma.marketingCollectionRun.findFirst({
    where: { storeId, platform: "GOOGLE" },
    orderBy: { startedAt: "desc" },
  });

  if (!lastRun || lastRun.outcome === null) {
    // Never checked, or the most recent attempt crashed before finishing
    // (outcome stays null — see persist.ts). Either way: genuinely unknown,
    // never presented as "no ads found."
    return {
      domain,
      platform: "GOOGLE",
      ads: unavailable(lastRun ? "Advertising check did not complete" : "Advertising data has not been checked yet"),
      lastCheckedAt: null,
      activity: null,
      productMatching: unavailable(PRODUCT_MATCHING_UNAVAILABLE_REASON),
      adSpend: unavailable(AD_SPEND_UNAVAILABLE_REASON),
      impressions: unavailable(IMPRESSIONS_UNAVAILABLE_REASON),
      conversions: unavailable(CONVERSIONS_UNAVAILABLE_REASON),
    };
  }

  if (lastRun.outcome === "UNAVAILABLE") {
    return {
      domain,
      platform: "GOOGLE",
      ads: unavailable(lastRun.reason ?? "Advertising data could not be checked"),
      lastCheckedAt: lastRun.finishedAt?.toISOString() ?? null,
      activity: null,
      productMatching: unavailable(PRODUCT_MATCHING_UNAVAILABLE_REASON),
      adSpend: unavailable(AD_SPEND_UNAVAILABLE_REASON),
      impressions: unavailable(IMPRESSIONS_UNAVAILABLE_REASON),
      conversions: unavailable(CONVERSIONS_UNAVAILABLE_REASON),
    };
  }

  const [ads, activity] = await Promise.all([
    prisma.adObservation.findMany({
      where: { storeId, platform: "GOOGLE", status: "ACTIVE_EVIDENCE" },
      orderBy: { firstSeenAt: "desc" },
      select: {
        externalAdId: true,
        destinationUrl: true,
        advertiserName: true,
        format: true,
        matchConfidence: true,
        firstSeenAt: true,
        lastSeenAt: true,
        sourceMetadata: true,
        matchedProduct: { select: { id: true, handle: true, title: true } },
      },
    }),
    getMarketingActivitySummary(prisma, storeId),
  ]);

  return {
    domain,
    platform: "GOOGLE",
    activity,
    productMatching: unavailable(PRODUCT_MATCHING_UNAVAILABLE_REASON),
    adSpend: unavailable(AD_SPEND_UNAVAILABLE_REASON),
    impressions: unavailable(IMPRESSIONS_UNAVAILABLE_REASON),
    conversions: unavailable(CONVERSIONS_UNAVAILABLE_REASON),
    ads: observed(
      ads.map((a) => ({
        externalAdId: a.externalAdId,
        destinationUrl: a.destinationUrl,
        regions: extractRegionNames(a.sourceMetadata),
        advertiserName: a.advertiserName,
        format: a.format,
        matchedProduct: a.matchedProduct,
        matchConfidence: a.matchConfidence,
        firstSeenAt: a.firstSeenAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
      })),
    ),
    lastCheckedAt: lastRun.finishedAt?.toISOString() ?? null,
  };
}

/**
 * sourceMetadata is untyped jsonb (see google-serpapi.ts's buildSourceMetadata)
 * — defensive extraction, same discipline as the adapter's own parsing:
 * an unexpected shape yields null, never a crash or a fabricated region.
 */
function extractRegionNames(sourceMetadata: unknown): string[] | null {
  if (typeof sourceMetadata !== "object" || sourceMetadata === null) return null;
  const regions = (sourceMetadata as Record<string, unknown>).regions;
  if (!Array.isArray(regions)) return null;

  const names = regions
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => r.regionName)
    .filter((name): name is string => typeof name === "string" && name.length > 0);

  return names.length > 0 ? names : null;
}
