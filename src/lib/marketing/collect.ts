import { buildProductMatchIndex, matchDestinationUrl } from "./normalize-url";
import type { MarketingAdSource, ObservedAd, PreviousAdState } from "./types";

/**
 * Talks to the vendor (via a MarketingAdSource) and resolves a store's
 * current advertising into ObservedAd[], ready for diffAds(). This is the
 * IO+cost-control boundary — diff.ts stays pure and knows nothing about
 * vendors, HTTP, or request budgets.
 *
 * Cost control: getAdDetails() (the costlier per-ad call) is only invoked
 * for ads we have never successfully resolved a destination URL for.
 * Everything else is served from `previous` — the same "only do the
 * expensive thing on change" discipline diff/persist.ts already applies to
 * ProductStateSnapshot history rows. Steady state cost is ~1-2 requests per
 * store per check (the search tier), not 1 + N.
 */

export interface CollectAdsArgs {
  source: MarketingAdSource;
  domain: string;
  /** Previously known ads for this store+platform — enables the cache-skip above. */
  previous: PreviousAdState[];
  /** This store's current product catalog, for exact-URL matching. */
  products: Array<{ id: string; handle: string }>;
}

export type CollectAdsResult =
  | { outcome: "SUCCESS"; ads: ObservedAd[]; requestCount: number }
  | { outcome: "NO_ADVERTISER_FOUND"; requestCount: number }
  | { outcome: "UNAVAILABLE"; reason: string; requestCount: number };

export async function collectAdsForStore(args: CollectAdsArgs): Promise<CollectAdsResult> {
  const { source, domain, previous, products } = args;

  const search = await source.searchAdsForDomain(domain);
  let requestCount = search.requestCount;

  if (search.outcome === "UNAVAILABLE") {
    return { outcome: "UNAVAILABLE", reason: search.reason, requestCount };
  }
  if (search.outcome === "NO_ADVERTISER_FOUND") {
    return { outcome: "NO_ADVERTISER_FOUND", requestCount };
  }

  const previousById = new Map(previous.map((a) => [a.externalAdId, a]));
  const matchIndex = buildProductMatchIndex(domain, products);
  const resolved: ObservedAd[] = [];

  for (const summary of search.ads) {
    const cached = previousById.get(summary.externalAdId);

    let destinationUrl: string | null;
    let advertiserName: string | null;
    let format: string | null;
    let sourceMetadata: Record<string, unknown> | null;

    if (cached && cached.destinationUrl !== null) {
      // Already resolved in a previous cycle — skip the paid details call.
      // sourceMetadata is intentionally null here (not "we know it's
      // empty"): the persistence layer preserves the existing stored value
      // rather than clobbering it with this "no fresh data" signal.
      destinationUrl = cached.destinationUrl;
      advertiserName = summary.advertiserName ?? cached.advertiserName;
      format = summary.format ?? cached.format;
      sourceMetadata = null;
    } else {
      const details = await source.getAdDetails(summary);
      requestCount += details.requestCount;

      if (details.outcome === "UNAVAILABLE") {
        // Honest partial result (failure case C): the ad EXISTS — the
        // search step observed it — but we could not resolve its
        // destination URL this cycle. Never fabricate one; leave it null
        // so matching simply can't happen yet, and retry details next
        // cycle (destinationUrl staying null keeps it eligible for retry).
        destinationUrl = null;
        advertiserName = summary.advertiserName;
        format = summary.format;
        sourceMetadata = null;
      } else {
        destinationUrl = details.details.destinationUrl;
        advertiserName = details.details.advertiserName ?? summary.advertiserName;
        format = details.details.format ?? summary.format;
        sourceMetadata = details.details.sourceMetadata;
      }
    }

    const match = matchDestinationUrl(destinationUrl, matchIndex);

    resolved.push({
      externalAdId: summary.externalAdId,
      destinationUrl,
      advertiserExternalId: summary.advertiserExternalId,
      advertiserName,
      format,
      sourceMetadata,
      matchedProductId: match?.productId ?? null,
      matchMethod: match?.method ?? null,
      matchConfidence: match?.confidence ?? null,
    });
  }

  return { outcome: "SUCCESS", ads: resolved, requestCount };
}
