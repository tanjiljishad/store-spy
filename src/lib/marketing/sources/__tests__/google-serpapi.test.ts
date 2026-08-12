import { describe, expect, it, vi, beforeEach } from "vitest";
import { createGoogleAdsSource } from "../google-serpapi";
import { _resetRateLimitState } from "../../../security/rate-limit";

/**
 * Fixtures below mirror the REAL response shape confirmed live in Sub-phase D
 * (7 authenticated calls against a real advertiser) — not the Sub-phase B
 * guesses. See google-serpapi.ts's module header for the full evidence
 * trail. Field values here are fictional (example.com), but the shape,
 * field names, and nesting are real.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Routes by call index (1st call, 2nd call, ...) so multi-step flows are easy to script. */
function sequencedFetch(responses: Array<Response | (() => Response) | (() => Promise<Response>)>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const entry = responses[i] ?? responses[responses.length - 1];
    i++;
    return typeof entry === "function" ? entry() : entry;
  });
  return fn as unknown as typeof fetch;
}

const SEARCH_OK = {
  search_metadata: { status: "Success" },
  search_information: { total_results: 2 },
  ad_creatives: [
    {
      advertiser_id: "AR001",
      advertiser: "Acme Inc",
      ad_creative_id: "CR001",
      format: "text",
      target_domain: "example.com",
      total_days_shown: 30,
      first_shown: 1700000000,
      last_shown: 1700500000,
      details_link: "https://adstransparency.google.com/advertiser/AR001/creative/CR001",
      serpapi_details_link: "https://serpapi.com/search.json?advertiser_id=AR001&creative_id=CR001&engine=google_ads_transparency_center_ad_details",
    },
    {
      advertiser_id: "AR001",
      advertiser: "Acme Inc",
      ad_creative_id: "CR002",
      format: "image",
      target_domain: "example.com",
      total_days_shown: 12,
      first_shown: 1701000000,
      last_shown: 1701500000,
      details_link: "https://adstransparency.google.com/advertiser/AR001/creative/CR002",
      serpapi_details_link: "https://serpapi.com/search.json?advertiser_id=AR001&creative_id=CR002&engine=google_ads_transparency_center_ad_details",
    },
  ],
};

const DETAILS_OK = {
  search_metadata: { status: "Success" },
  search_parameters: { engine: "google_ads_transparency_center_ad_details", advertiser_id: "AR001", creative_id: "CR001" },
  search_information: {
    format: "text",
    last_shown: 1700500000,
    region_name: "anywhere",
    more_ads_by_advertiser: "https://adstransparency.google.com/advertiser/AR001",
    ad_funded_by: "Acme Inc",
    regions: [{ region: 2840, region_name: "United States", first_shown: 20250101, last_shown: 20250601 }],
  },
  ad_creatives: [{ image: "https://tpc.googlesyndication.com/archive/simgad/example" }],
};

beforeEach(() => {
  _resetRateLimitState();
});

function makeSource(fetchImpl: typeof fetch) {
  return createGoogleAdsSource({ apiKey: "test-key", fetchImpl, rateLimit: { limit: 100, windowMs: 1_000 } });
}

describe("GoogleAdsSource.searchAdsForDomain", () => {
  it("successful response: ONE call returns ad_creatives directly — no separate advertiser-lookup step", async () => {
    const fetchImpl = sequencedFetch([jsonResponse(SEARCH_OK)]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads).toEqual([
      { externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme Inc", format: "text" },
      { externalAdId: "CR002", advertiserExternalId: "AR001", advertiserName: "Acme Inc", format: "image" },
    ]);
    expect(result.requestCount).toBe(1); // ONE call, confirmed live — not two
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("empty response: zero ad_creatives is OBSERVED success, not a failure", async () => {
    const fetchImpl = sequencedFetch([jsonResponse({ search_information: { total_results: 0 }, ad_creatives: [] })]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result).toEqual({ outcome: "SUCCESS", ads: [], requestCount: 1 });
  });

  it("multiple, unrelated advertisers can share the same target_domain — every ad's real advertiser is surfaced as-is, never attributed to 'the store'", async () => {
    // Confirmed live: a real domain's search results included both the
    // brand's own ads AND an unrelated third party's ads pointing at the
    // same target_domain (e.g. an affiliate/reseller). Never silently
    // collapse or relabel — surface each ad's own vendor-reported advertiser.
    const mixed = {
      search_information: { total_results: 2 },
      ad_creatives: [
        { advertiser_id: "AR001", advertiser: "Acme Inc", ad_creative_id: "CR001", format: "text", target_domain: "example.com" },
        { advertiser_id: "AR999", advertiser: "Unrelated Reseller LLC", ad_creative_id: "CR999", format: "text", target_domain: "example.com" },
      ],
    };
    const fetchImpl = sequencedFetch([jsonResponse(mixed)]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads.map((a) => a.advertiserName)).toEqual(["Acme Inc", "Unrelated Reseller LLC"]);
  });

  it("defensively drops any ad_creative whose target_domain doesn't match the queried domain", async () => {
    const mismatched = {
      ad_creatives: [
        { advertiser_id: "AR001", advertiser: "Acme Inc", ad_creative_id: "CR001", format: "text", target_domain: "example.com" },
        { advertiser_id: "AR002", advertiser: "Someone Else", ad_creative_id: "CR002", format: "text", target_domain: "totally-different-site.com" },
      ],
    };
    const fetchImpl = sequencedFetch([jsonResponse(mismatched)]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads.map((a) => a.externalAdId)).toEqual(["CR001"]);
  });

  it("malformed response: missing expected fields never crashes and never fabricates an ad", async () => {
    const fetchImpl = sequencedFetch([jsonResponse({ unexpected: "shape" })]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/unrecognized response shape/);
  });

  it("malformed response: ads array present but entries are garbage or missing an advertiser id — skips them, doesn't crash", async () => {
    const fetchImpl = sequencedFetch([
      jsonResponse({ ad_creatives: [{ ad_creative_id: "CR1" /* no advertiser_id */ }, null, "garbage"] }),
    ]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result).toEqual({ outcome: "SUCCESS", ads: [], requestCount: 1 });
  });

  it("rate limit: exhausting the local gate blocks further calls without hitting the network", async () => {
    const fetchImpl = sequencedFetch([jsonResponse(SEARCH_OK)]);
    const source = createGoogleAdsSource({
      apiKey: "test-key",
      fetchImpl,
      rateLimit: { limit: 1, windowMs: 60_000 },
    });

    const first = await source.searchAdsForDomain("example.com"); // consumes the 1 allowed call
    expect(first.outcome).toBe("SUCCESS");
    const callsAfterFirst = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const second = await source.searchAdsForDomain("example.com");

    expect(second.outcome).toBe("UNAVAILABLE");
    if (second.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(second.reason).toMatch(/rate limited/);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterFirst);
  });

  it("auth failure: HTTP 401 is reported as UNAVAILABLE and is not retried", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const source = makeSource(fetchImpl as unknown as typeof fetch);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/authentication failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry on a non-retryable failure
  });

  it("timeout: an aborted request is reported as UNAVAILABLE after one retry", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const source = createGoogleAdsSource({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
      rateLimit: { limit: 100, windowMs: 1_000 },
    });

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/timed out/);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // timeouts are retried once
  });

  it("vendor error: SerpApi's { error: ... } 200-status envelope is treated as a failure, not success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Invalid API key." }));
    const source = makeSource(fetchImpl as unknown as typeof fetch);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/Invalid API key/);
  });

  it("oversized response: a body past the byte cap is rejected cleanly, never buffered unbounded (Sub-phase D security review)", async () => {
    const huge = JSON.stringify({ ad_creatives: [{ advertiser_id: "AR001", padding: "x".repeat(6 * 1024 * 1024) }] });
    const fetchImpl = vi.fn(async () => new Response(huge, { status: 200 }));
    const source = makeSource(fetchImpl as unknown as typeof fetch);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/byte limit/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not retryable — retrying an oversized response wouldn't help
  });

  it("5xx vendor server errors ARE retried once", async () => {
    const fetchImpl = sequencedFetch([jsonResponse({}, 502), jsonResponse(SEARCH_OK)]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 failed + 1 retry-succeeded
    expect(result.outcome).toBe("SUCCESS");
  });

  it("pagination: follows serpapi_pagination.next and accumulates ads across pages, bounded by a safety cap", async () => {
    const page1 = {
      ad_creatives: [{ advertiser_id: "AR001", advertiser: "Acme Inc", ad_creative_id: "CR001", format: "text", target_domain: "example.com" }],
      serpapi_pagination: { next: "https://serpapi.com/search.json?page=2" },
    };
    const page2 = {
      ad_creatives: [{ advertiser_id: "AR001", advertiser: "Acme Inc", ad_creative_id: "CR002", format: "image", target_domain: "example.com" }],
    };
    const fetchImpl = sequencedFetch([jsonResponse(page1), jsonResponse(page2)]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads.map((a) => a.externalAdId)).toEqual(["CR001", "CR002"]);
    expect(result.requestCount).toBe(2);
  });

  it("pagination: a response with no serpapi_pagination field is treated as a single page", async () => {
    const fetchImpl = sequencedFetch([jsonResponse(SEARCH_OK)]);
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads).toHaveLength(2);
    expect(result.requestCount).toBe(1);
  });

  it("pagination cap: stops after MAX_AD_PAGES even when the vendor offers more (Sub-phase D cost fix — a real advertiser had 2000 total_results)", async () => {
    const page = (n: number, hasNext: boolean) => ({
      ad_creatives: [{ advertiser_id: "AR001", advertiser: "Acme Inc", ad_creative_id: `CR00${n}`, format: "text", target_domain: "example.com" }],
      ...(hasNext ? { serpapi_pagination: { next: `https://serpapi.com/search.json?page=${n + 1}` } } : {}),
    });
    // 5 pages offered by the vendor; the cap (2) must stop well short of that.
    const fetchImpl = sequencedFetch([1, 2, 3, 4, 5].map((n) => jsonResponse(page(n, n < 5))));
    const source = makeSource(fetchImpl);

    const result = await source.searchAdsForDomain("example.com");

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads.map((a) => a.externalAdId)).toEqual(["CR001", "CR002"]); // exactly 2 pages, not 5
    expect(result.requestCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GoogleAdsSource.getAdDetails", () => {
  const summary = { externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme Inc", format: "text" };

  it("successful response: extracts real fields (ad_funded_by, format, regions) — destinationUrl is null (confirmed absent live, see google-serpapi.ts header)", async () => {
    const fetchImpl = sequencedFetch([jsonResponse(DETAILS_OK)]);
    const source = makeSource(fetchImpl);

    const result = await source.getAdDetails(summary);

    expect(result).toEqual({
      outcome: "SUCCESS",
      requestCount: 1,
      details: {
        externalAdId: "CR001",
        destinationUrl: null,
        advertiserExternalId: "AR001",
        advertiserName: "Acme Inc", // from ad_funded_by
        format: "text",
        sourceMetadata: {
          // top-level first_shown wasn't present in the real fixture this
          // mirrors (only some ads' search_information disclose it — real,
          // observed inconsistency, not a test gap); lastShown is a number,
          // not a string, correcting Sub-phase B's assumption.
          lastShown: 1700500000,
          regions: [{ regionName: "United States", firstShown: 20250101, lastShown: 20250601 }],
        },
      },
    });
  });

  it("falls back to the AdSummary's own advertiserName/format when search_information omits them", async () => {
    const fetchImpl = sequencedFetch([jsonResponse({ search_information: {}, ad_creatives: [{ image: "https://x" }] })]);
    const source = makeSource(fetchImpl);

    const result = await source.getAdDetails(summary);

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.details.advertiserName).toBe("Acme Inc");
    expect(result.details.format).toBe("text");
    expect(result.details.destinationUrl).toBeNull();
    expect(result.details.sourceMetadata).toBeNull();
  });

  it("a vendor { error: ... } response (e.g. video ads with no detail data) is UNAVAILABLE, not a fabricated empty success", async () => {
    const fetchImpl = sequencedFetch([
      jsonResponse({ search_information: { format: "video" }, error: "Google Ads Transparency Center Ad Details hasn't returned any results for this query." }),
    ]);
    const source = makeSource(fetchImpl);

    const result = await source.getAdDetails({ ...summary, format: "video" });

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/hasn't returned any results/);
  });

  it("malformed response: missing search_information entirely is UNAVAILABLE, not a silent null-fest", async () => {
    const fetchImpl = sequencedFetch([jsonResponse({ unexpected: "shape" })]);
    const source = makeSource(fetchImpl);

    const result = await source.getAdDetails(summary);

    expect(result.outcome).toBe("UNAVAILABLE");
    if (result.outcome !== "UNAVAILABLE") throw new Error("unreachable");
    expect(result.reason).toMatch(/unrecognized response shape/);
  });

  it("refuses to fetch details for an ad with no known advertiser id", async () => {
    const fetchImpl = vi.fn();
    const source = createGoogleAdsSource({ apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await source.getAdDetails({ ...summary, advertiserExternalId: null });

    expect(result.outcome).toBe("UNAVAILABLE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
