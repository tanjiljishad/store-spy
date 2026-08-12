import { describe, expect, it, vi } from "vitest";
import { collectAdsForStore } from "../collect";
import type { AdDetails, AdSummary, DetailsResult, MarketingAdSource, PreviousAdState, SearchResult } from "../types";

function fakeSource(overrides: Partial<MarketingAdSource> = {}): MarketingAdSource {
  return {
    platform: "GOOGLE",
    source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
    searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({ outcome: "SUCCESS", ads: [], requestCount: 1 })),
    getAdDetails: vi.fn(async (ad: AdSummary): Promise<DetailsResult> => ({
      outcome: "SUCCESS",
      requestCount: 1,
      details: {
        externalAdId: ad.externalAdId,
        destinationUrl: "https://example.com/products/blue-shirt",
        advertiserExternalId: ad.advertiserExternalId,
        advertiserName: ad.advertiserName,
        format: ad.format,
        sourceMetadata: null,
      } satisfies AdDetails,
    })),
    ...overrides,
  };
}

const PRODUCTS = [{ id: "p1", handle: "blue-shirt" }];

describe("collectAdsForStore — outcome propagation", () => {
  it("propagates UNAVAILABLE from the search step without calling getAdDetails", async () => {
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({ outcome: "UNAVAILABLE", reason: "vendor down", requestCount: 1 })),
    });

    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });

    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "vendor down", requestCount: 1 });
    expect(source.getAdDetails).not.toHaveBeenCalled();
  });

  it("propagates NO_ADVERTISER_FOUND", async () => {
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({ outcome: "NO_ADVERTISER_FOUND", requestCount: 1 })),
    });

    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });

    expect(result).toEqual({ outcome: "NO_ADVERTISER_FOUND", requestCount: 1 });
  });

  it("a genuinely empty ad list is SUCCESS with ads: [] — never confused with UNAVAILABLE", async () => {
    const source = fakeSource();
    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });
    expect(result).toEqual({ outcome: "SUCCESS", ads: [], requestCount: 1 });
  });
});

describe("collectAdsForStore — cost control (details caching)", () => {
  it("fetches details for a brand-new ad", async () => {
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({
        outcome: "SUCCESS",
        ads: [{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }],
        requestCount: 1,
      })),
    });

    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });

    expect(source.getAdDetails).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads[0].destinationUrl).toBe("https://example.com/products/blue-shirt");
    expect(result.requestCount).toBe(2); // 1 search + 1 details
  });

  it("does NOT re-fetch details for an ad whose destination URL is already cached", async () => {
    const cachedPrevious: PreviousAdState = {
      id: "ad1",
      externalAdId: "CR001",
      destinationUrl: "https://example.com/products/blue-shirt",
      advertiserExternalId: "AR001",
      advertiserName: "Acme",
      format: "text",
      status: "ACTIVE_EVIDENCE",
      missingStreak: 0,
      matchedProductId: "p1",
      matchMethod: "EXACT_PRODUCT_URL",
      matchConfidence: "HIGH",
      firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    };
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({
        outcome: "SUCCESS",
        ads: [{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }],
        requestCount: 1,
      })),
    });

    const result = await collectAdsForStore({
      source,
      domain: "example.com",
      previous: [cachedPrevious],
      products: PRODUCTS,
    });

    expect(source.getAdDetails).not.toHaveBeenCalled();
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads[0].destinationUrl).toBe("https://example.com/products/blue-shirt");
    expect(result.requestCount).toBe(1); // search only — cost control working
  });

  it("DOES re-fetch details for a previously-known ad whose destination URL was never resolved", async () => {
    const neverResolved: PreviousAdState = {
      id: "ad1",
      externalAdId: "CR001",
      destinationUrl: null,
      advertiserExternalId: "AR001",
      advertiserName: "Acme",
      format: "text",
      status: "ACTIVE_EVIDENCE",
      missingStreak: 0,
      matchedProductId: null,
      matchMethod: null,
      matchConfidence: null,
      firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    };
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({
        outcome: "SUCCESS",
        ads: [{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }],
        requestCount: 1,
      })),
    });

    await collectAdsForStore({ source, domain: "example.com", previous: [neverResolved], products: PRODUCTS });

    expect(source.getAdDetails).toHaveBeenCalledTimes(1);
  });

  it("a failed details call leaves destinationUrl null rather than fabricating one (case C)", async () => {
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({
        outcome: "SUCCESS",
        ads: [{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }],
        requestCount: 1,
      })),
      getAdDetails: vi.fn(async (): Promise<DetailsResult> => ({ outcome: "UNAVAILABLE", reason: "timeout", requestCount: 1 })),
    });

    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });

    expect(result.outcome).toBe("SUCCESS"); // the ad's EXISTENCE was still observed
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads[0].destinationUrl).toBeNull();
    expect(result.ads[0].matchedProductId).toBeNull(); // can't match without a URL
  });
});

describe("collectAdsForStore — matching", () => {
  it("matches a resolved ad against the store's product catalog", async () => {
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({
        outcome: "SUCCESS",
        ads: [{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }],
        requestCount: 1,
      })),
    });

    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads[0]).toMatchObject({ matchedProductId: "p1", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" });
  });

  it("leaves an ad unmatched when its destination URL isn't in the catalog", async () => {
    const source = fakeSource({
      searchAdsForDomain: vi.fn(async (): Promise<SearchResult> => ({
        outcome: "SUCCESS",
        ads: [{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }],
        requestCount: 1,
      })),
      getAdDetails: vi.fn(async (ad: AdSummary): Promise<DetailsResult> => ({
        outcome: "SUCCESS",
        requestCount: 1,
        details: {
          externalAdId: ad.externalAdId,
          destinationUrl: "https://example.com/pages/some-landing-page",
          advertiserExternalId: ad.advertiserExternalId,
          advertiserName: ad.advertiserName,
          format: ad.format,
          sourceMetadata: null,
        },
      })),
    });

    const result = await collectAdsForStore({ source, domain: "example.com", previous: [], products: PRODUCTS });

    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("unreachable");
    expect(result.ads[0].matchedProductId).toBeNull();
  });
});
