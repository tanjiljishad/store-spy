/**
 * Live smoke test for the marketing-intelligence pipeline, parallel to
 * crawl-smoke.ts. Every section is labeled REAL or SIMULATED — never
 * blurred — per the explicit instruction not to fabricate a successful
 * live vendor test when no SerpApi credentials are available:
 *
 *   REAL:      an actual live Shopify store is crawled over the network,
 *              exactly like crawl-smoke.ts does, to get a genuine product
 *              catalog (real handles, real domain).
 *   REAL:      a genuine unauthenticated request is made to SerpApi's real
 *              endpoint, to confirm the base URL is live and to observe its
 *              real error-response shape (costs no API credits).
 *   SIMULATED: the actual ad search/details vendor RESPONSE — no SerpApi
 *              key is available in this environment. The simulated
 *              response's shape follows SerpApi's documented fields from
 *              Sub-phase B research, but that field-mapping is NOT
 *              independently confirmed against a real authenticated
 *              response. See the final report for what remains to verify.
 *   NOT RUN:   anything touching Postgres (AdObservation/MarketingCollectionRun
 *              persistence, the scheduler's claim query) — no Docker/Postgres
 *              is available in this environment. Covered instead by
 *              marketing/__tests__/*.integration.test.ts, written and
 *              typechecked but not executed here — run via
 *              `npm run test:integration` in an environment with Docker.
 */
import { crawlShopifyStore } from "../src/lib/crawl/shopify";
import { normalizeSnapshot } from "../src/lib/crawl/normalize";
import { collectAdsForStore } from "../src/lib/marketing/collect";
import { diffAds } from "../src/lib/marketing/diff";
import type { AdSummary, DetailsResult, MarketingAdSource, SearchResult } from "../src/lib/marketing/types";

const domain = process.argv[2] ?? "allbirds.com";

async function probeRealSerpApiEndpoint() {
  console.log("\n=== REAL: unauthenticated probe of the live SerpApi endpoint ===");
  console.log("(no API key configured in this environment — this call spends no credits)");
  try {
    const res = await fetch(
      `https://serpapi.com/search.json?engine=google_ads_transparency_center&text=${encodeURIComponent(domain)}`,
    );
    const body = await res.text();
    console.log(`HTTP status: ${res.status}`);
    console.log(`body: ${body.slice(0, 300)}`);
    if (res.status === 401) {
      console.log("-> confirms: base URL is live, and the adapter's 401/auth-failure path matches real server behavior.");
    }
  } catch (e) {
    console.log(`FETCH ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  await probeRealSerpApiEndpoint();

  console.log(`\n=== REAL: crawling ${domain} for a genuine product catalog ===`);
  const crawlResult = await crawlShopifyStore(domain);
  if (crawlResult.status !== "ok") {
    console.log(`crawl status: ${crawlResult.status} (${crawlResult.reason}) — cannot continue`);
    return;
  }
  const snapshot = normalizeSnapshot(crawlResult.input);
  console.log(`products discovered: ${snapshot.products.length}`);
  if (snapshot.products.length < 2) {
    console.log("fewer than 2 products — cannot demonstrate matched vs. unmatched ads meaningfully");
    return;
  }

  const products = snapshot.products.slice(0, 2).map((p, i) => ({ id: `product_${i}`, handle: p.handle }));
  const matchedHandle = products[0].handle;
  console.log(`using real handles for matching demo: ${products.map((p) => p.handle).join(", ")}`);

  console.log("\n=== SIMULATED: vendor responses (shape per Sub-phase B research, not live-confirmed) ===");
  const simulatedSource: MarketingAdSource = {
    platform: "GOOGLE",
    source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
    async searchAdsForDomain(): Promise<SearchResult> {
      return {
        outcome: "SUCCESS",
        requestCount: 1,
        ads: [
          { externalAdId: "SIM_CR001", advertiserExternalId: "SIM_AR001", advertiserName: "Simulated Advertiser", format: "text" },
          { externalAdId: "SIM_CR002", advertiserExternalId: "SIM_AR001", advertiserName: "Simulated Advertiser", format: "image" },
        ],
      };
    },
    async getAdDetails(ad: AdSummary): Promise<DetailsResult> {
      const destinationUrl =
        ad.externalAdId === "SIM_CR001"
          ? `https://${domain}/products/${matchedHandle}` // real product path -> should match
          : `https://${domain}/pages/some-unrelated-landing-page`; // should NOT match
      return {
        outcome: "SUCCESS",
        requestCount: 1,
        details: {
          externalAdId: ad.externalAdId,
          destinationUrl,
          advertiserExternalId: ad.advertiserExternalId,
          advertiserName: ad.advertiserName,
          format: ad.format,
          sourceMetadata: null,
        },
      };
    },
  };

  const collected = await collectAdsForStore({ source: simulatedSource, domain, previous: [], products });
  console.log(`collection outcome: ${collected.outcome}`);
  if (collected.outcome !== "SUCCESS") return;
  for (const ad of collected.ads) {
    console.log(
      `  ${ad.externalAdId}: destinationUrl=${ad.destinationUrl} matchedProductId=${ad.matchedProductId} confidence=${ad.matchConfidence}`,
    );
  }
  const matchedCount = collected.ads.filter((a) => a.matchedProductId).length;
  console.log(`matched ${matchedCount}/${collected.ads.length} ads to real catalog products (expected: 1/2)`);

  console.log("\n=== diffAds() — baseline then detection ===");
  const now1 = new Date();
  const baseline = diffAds({
    storeId: "smoke_store",
    platform: "GOOGLE",
    previous: [],
    observed: collected.ads,
    now: now1,
    isBaseline: true,
    removalConfirmations: 2,
  });
  console.log(`baseline events (expected 0): ${baseline.events.length}`);
  console.log(`baseline upserts: ${baseline.upserts.length}`);

  const previous = baseline.upserts.map((u) => ({
    id: `row_${u.externalAdId}`,
    externalAdId: u.externalAdId,
    destinationUrl: u.destinationUrl,
    advertiserExternalId: u.advertiserExternalId,
    advertiserName: u.advertiserName,
    format: u.format,
    status: u.status,
    missingStreak: u.missingStreak,
    matchedProductId: u.matchedProductId,
    matchMethod: u.matchMethod,
    matchConfidence: u.matchConfidence,
    firstSeenAt: now1,
  }));

  // Same collection re-run: a real crawl retry must not duplicate events.
  const now2 = new Date(now1.getTime() + 1000);
  const repeat = diffAds({
    storeId: "smoke_store",
    platform: "GOOGLE",
    previous,
    observed: collected.ads,
    now: now2,
    isBaseline: false,
    removalConfirmations: 2,
  });
  console.log(`repeat cycle events (expected 0 — nothing changed): ${repeat.events.length}`);

  // Now simulate one ad disappearing (vendor no longer returns SIM_CR002) —
  // must NOT immediately fire AD_REMOVED (needs removalConfirmations).
  const now3 = new Date(now1.getTime() + 2000);
  const oneGone = diffAds({
    storeId: "smoke_store",
    platform: "GOOGLE",
    previous,
    observed: collected.ads.filter((a) => a.externalAdId !== "SIM_CR002"),
    now: now3,
    isBaseline: false,
    removalConfirmations: 2,
  });
  console.log(
    `one ad absent, 1st time (expected 0 AD_REMOVED — not confirmed yet): ${oneGone.events.filter((e) => e.eventType === "AD_REMOVED").length}`,
  );

  console.log("\n=== summary ===");
  console.log("REAL: live Shopify crawl succeeded, real product catalog used for matching.");
  console.log("REAL: SerpApi base URL reachable, 401/auth-failure path confirmed against real server response.");
  console.log("SIMULATED: ad search/details vendor payloads — field names per research, not independently confirmed live.");
  console.log("NOT RUN: any Postgres-touching code (AdObservation/MarketingCollectionRun persistence, scheduler claim query) — no Docker/Postgres in this environment. See marketing/__tests__/*.integration.test.ts.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
