/**
 * Vendor-agnostic contracts for marketing/advertising intelligence
 * collection. GoogleAdsSource (backed by SerpApi's Google Ads Transparency
 * Center API) is the only concrete implementation this sub-phase. A future
 * Meta source is additive against this same interface — nothing here may
 * assume Google-specific request/response shapes; those live entirely in
 * sources/google-serpapi.ts.
 *
 * Two-tier shape (search vs. details) mirrors the vendor's actual cost
 * structure: listing a domain's ads is cheap, resolving one ad's real
 * destination URL is a separate, costlier call. Keeping that distinction in
 * the interface — rather than flattening it into one "get everything" call
 * — is what lets the orchestration layer (collect.ts) fetch full details
 * only for ads it hasn't already cached, the same "only do the expensive
 * thing on change" discipline diff/persist.ts already uses for history rows.
 */

export type AdPlatform = "GOOGLE";
export type MatchMethod = "EXACT_PRODUCT_URL";
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";
export type AdObservationStatus = "ACTIVE_EVIDENCE" | "HISTORICAL";
export type MarketingCollectionOutcome = "SUCCESS" | "UNAVAILABLE";

/** One ad as listed by the cheap search/list call — no destination URL yet. */
export interface AdSummary {
  externalAdId: string;
  advertiserExternalId: string | null;
  advertiserName: string | null;
  format: string | null;
}

/** One ad's resolved details from the costlier per-ad call. */
export interface AdDetails {
  externalAdId: string;
  destinationUrl: string | null;
  advertiserExternalId: string | null;
  advertiserName: string | null;
  format: string | null;
  /** Vendor-specific extra fields worth keeping. Never secrets/credentials. */
  sourceMetadata: Record<string, unknown> | null;
}

export type SearchResult =
  | { outcome: "SUCCESS"; ads: AdSummary[]; requestCount: number }
  /** The vendor has no advertiser record for this domain at all — distinct
   *  from SUCCESS with ads: [] (case A, "checked, none found"). This is
   *  "we couldn't even identify the advertiser" (case D in the spec). */
  | { outcome: "NO_ADVERTISER_FOUND"; requestCount: number }
  /** The vendor could not be reached, or returned something we can't trust
   *  (auth failure, timeout, rate-limited, malformed body, 5xx, ...). */
  | { outcome: "UNAVAILABLE"; reason: string; requestCount: number };

export type DetailsResult =
  | { outcome: "SUCCESS"; details: AdDetails; requestCount: number }
  | { outcome: "UNAVAILABLE"; reason: string; requestCount: number };

/**
 * Nothing outside sources/ may depend on vendor-specific request/response
 * shapes — everything crossing this boundary is already normalized.
 */
export interface MarketingAdSource {
  platform: AdPlatform;
  /** e.g. "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER" — persisted on AdObservation.source. */
  source: string;
  searchAdsForDomain(domain: string): Promise<SearchResult>;
  getAdDetails(ad: AdSummary): Promise<DetailsResult>;
}

/** Current DB state for one ad, loaded before diffing — mirrors PreviousEntityState. */
export interface PreviousAdState {
  id: string;
  externalAdId: string;
  destinationUrl: string | null;
  advertiserExternalId: string | null;
  advertiserName: string | null;
  format: string | null;
  status: AdObservationStatus;
  missingStreak: number;
  matchedProductId: string | null;
  matchMethod: MatchMethod | null;
  matchConfidence: MatchConfidence | null;
  firstSeenAt: Date;
}

/** A fully resolved ad, ready to hand to the diff engine. */
export interface ObservedAd {
  externalAdId: string;
  destinationUrl: string | null;
  advertiserExternalId: string | null;
  advertiserName: string | null;
  format: string | null;
  sourceMetadata: Record<string, unknown> | null;
  matchedProductId: string | null;
  matchMethod: MatchMethod | null;
  matchConfidence: MatchConfidence | null;
}
