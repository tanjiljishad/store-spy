import { describe, expect, it } from "vitest";
import { buildCatalogTrend, catalogSizeAt, sampleEvenly, type CatalogProductInput } from "../catalog";

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
