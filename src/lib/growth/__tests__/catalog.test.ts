import { describe, expect, it } from "vitest";
import { buildCatalogTrend, catalogSizeAt, evenlySpacedDates, sampleEvenly, type CatalogProductInput } from "../catalog";

const D = (s: string) => new Date(s);

describe("sampleEvenly", () => {
  it("returns everything when there are fewer items than maxPoints", () => {
    expect(sampleEvenly([1, 2, 3], 12)).toEqual([1, 2, 3]);
  });

  it("always includes the first and last item", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const sampled = sampleEvenly(items, 12);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(99);
    expect(sampled.length).toBeLessThanOrEqual(12);
  });

  it("returns exactly one item (the last) when maxPoints is 1", () => {
    expect(sampleEvenly([1, 2, 3, 4, 5], 1)).toEqual([5]);
  });

  it("returns nothing for an empty input", () => {
    expect(sampleEvenly([], 12)).toEqual([]);
  });
});

describe("catalogSizeAt", () => {
  it("counts a product only once firstSeenAt has passed", () => {
    const products: CatalogProductInput[] = [{ firstSeenAt: D("2026-06-01"), missingSince: null }];
    expect(catalogSizeAt(products, D("2026-05-01"))).toBe(0);
    expect(catalogSizeAt(products, D("2026-06-01"))).toBe(1);
    expect(catalogSizeAt(products, D("2026-07-01"))).toBe(1);
  });

  it("excludes a product from the moment it went missing", () => {
    const products: CatalogProductInput[] = [
      { firstSeenAt: D("2026-01-01"), missingSince: D("2026-06-01") },
    ];
    expect(catalogSizeAt(products, D("2026-05-31"))).toBe(1);
    expect(catalogSizeAt(products, D("2026-06-01"))).toBe(0);
    expect(catalogSizeAt(products, D("2026-07-01"))).toBe(0);
  });

  it("computes a plausible growth curve across several products", () => {
    const products: CatalogProductInput[] = [
      { firstSeenAt: D("2026-01-01"), missingSince: null },
      { firstSeenAt: D("2026-02-01"), missingSince: null },
      { firstSeenAt: D("2026-03-01"), missingSince: D("2026-05-01") },
      { firstSeenAt: D("2026-04-01"), missingSince: null },
    ];
    expect(catalogSizeAt(products, D("2026-01-15"))).toBe(1);
    expect(catalogSizeAt(products, D("2026-02-15"))).toBe(2);
    expect(catalogSizeAt(products, D("2026-03-15"))).toBe(3);
    expect(catalogSizeAt(products, D("2026-04-15"))).toBe(4);
    expect(catalogSizeAt(products, D("2026-05-15"))).toBe(3); // one went missing
  });
});

describe("catalogSizeAt — sourceCreatedAt-aware", () => {
  it("uses sourceCreatedAt over firstSeenAt when both are present", () => {
    // Discovered (firstSeenAt) on a single crawl in June, but really
    // launched on Shopify back in January — the January date must govern.
    const products: CatalogProductInput[] = [
      { firstSeenAt: D("2026-06-01"), missingSince: null, sourceCreatedAt: D("2026-01-01") },
    ];
    expect(catalogSizeAt(products, D("2026-02-01"))).toBe(1); // before firstSeenAt, after sourceCreatedAt
    expect(catalogSizeAt(products, D("2025-12-01"))).toBe(0); // before both
  });

  it("falls back to firstSeenAt when sourceCreatedAt is absent", () => {
    const products: CatalogProductInput[] = [{ firstSeenAt: D("2026-06-01"), missingSince: null }];
    expect(catalogSizeAt(products, D("2026-05-01"))).toBe(0);
    expect(catalogSizeAt(products, D("2026-06-01"))).toBe(1);
  });

  it("missingSince still excludes a product regardless of which start date was used", () => {
    const products: CatalogProductInput[] = [
      { firstSeenAt: D("2026-06-01"), missingSince: D("2026-08-01"), sourceCreatedAt: D("2026-01-01") },
    ];
    expect(catalogSizeAt(products, D("2026-07-01"))).toBe(1);
    expect(catalogSizeAt(products, D("2026-08-01"))).toBe(0);
  });
});

describe("evenlySpacedDates", () => {
  it("always includes both endpoints", () => {
    const dates = evenlySpacedDates(D("2024-01-01"), D("2026-01-01"), 12);
    expect(dates[0].toISOString()).toBe(D("2024-01-01").toISOString());
    expect(dates[dates.length - 1].toISOString()).toBe(D("2026-01-01").toISOString());
  });

  it("produces monotonically increasing dates", () => {
    const dates = evenlySpacedDates(D("2024-01-01"), D("2026-01-01"), 8);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i].getTime()).toBeGreaterThanOrEqual(dates[i - 1].getTime());
    }
  });

  it("collapses to a single point when start equals end", () => {
    expect(evenlySpacedDates(D("2026-01-01"), D("2026-01-01"), 12)).toEqual([D("2026-01-01")]);
  });

  it("returns nothing when start is after end", () => {
    expect(evenlySpacedDates(D("2026-06-01"), D("2026-01-01"), 12)).toEqual([]);
  });

  it("returns just the end date when maxPoints is 1", () => {
    expect(evenlySpacedDates(D("2024-01-01"), D("2026-01-01"), 1)).toEqual([D("2026-01-01")]);
  });
});

describe("buildCatalogTrend", () => {
  it("builds a chronological, bounded set of points from real crawl dates only", () => {
    const crawlDates = [D("2026-07-15"), D("2026-06-01"), D("2026-05-01")]; // unsorted on purpose
    const products: CatalogProductInput[] = [
      { firstSeenAt: D("2026-04-01"), missingSince: null },
      { firstSeenAt: D("2026-06-15"), missingSince: null },
    ];
    const points = buildCatalogTrend(crawlDates, products, 12);
    expect(points.map((p) => p.at.toISOString())).toEqual(
      [D("2026-05-01"), D("2026-06-01"), D("2026-07-15")].map((d) => d.toISOString()),
    );
    expect(points.map((p) => p.size)).toEqual([1, 1, 2]);
  });

  it("never fabricates a data point between two real crawl dates", () => {
    // Only two crawl dates were ever supplied — the trend must contain
    // exactly those two points, never an interpolated one in between.
    const crawlDates = [D("2026-01-01"), D("2026-08-01")];
    const products: CatalogProductInput[] = [{ firstSeenAt: D("2026-01-01"), missingSince: null }];
    const points = buildCatalogTrend(crawlDates, products, 12);
    expect(points).toHaveLength(2);
  });
});
