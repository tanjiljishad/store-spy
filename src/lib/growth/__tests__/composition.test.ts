import { describe, expect, it } from "vitest";
import { computeCatalogComposition, type CompositionProductInput } from "../composition";

function product(overrides: Partial<CompositionProductInput> = {}): CompositionProductInput {
  return { priceMinCents: 1000, compareAtMaxCents: null, vendor: null, productType: null, ...overrides };
}

describe("computeCatalogComposition — price spread", () => {
  it("computes min/max/median/p25/p75 from priceMinCents", () => {
    const products = [1000, 2000, 3000, 4000, 5000].map((priceMinCents) => product({ priceMinCents }));
    const result = computeCatalogComposition(products);
    expect(result.priceSpread.minCents).toBe(1000);
    expect(result.priceSpread.maxCents).toBe(5000);
    expect(result.priceSpread.medianCents).toBe(3000);
  });

  it("handles a single product without dividing by zero or crashing", () => {
    const result = computeCatalogComposition([product({ priceMinCents: 2500 })]);
    expect(result.priceSpread).toEqual({ minCents: 2500, maxCents: 2500, medianCents: 2500, p25Cents: 2500, p75Cents: 2500 });
  });
});

describe("computeCatalogComposition — discount depth", () => {
  it("counts a product as discounted only when compareAtMaxCents exceeds the current price", () => {
    const products = [
      product({ priceMinCents: 1000, compareAtMaxCents: 2000 }), // 50% off
      product({ priceMinCents: 1000, compareAtMaxCents: null }), // no compare-at at all
      product({ priceMinCents: 1000, compareAtMaxCents: 1000 }), // compare-at equals price — not a discount
      product({ priceMinCents: 1000, compareAtMaxCents: 900 }), // compare-at BELOW price — not a discount
    ];
    const result = computeCatalogComposition(products);
    expect(result.discountDepth.discountedCount).toBe(1);
    expect(result.discountDepth.totalCount).toBe(4);
    expect(result.discountDepth.averageDiscountPercent).toBe(50);
  });

  it("averageDiscountPercent is null when nothing is discounted, never zero (zero would imply a measured 0%)", () => {
    const result = computeCatalogComposition([product(), product()]);
    expect(result.discountDepth.discountedCount).toBe(0);
    expect(result.discountDepth.averageDiscountPercent).toBeNull();
  });

  it("averages discount percent only across discounted products, not the whole catalog", () => {
    const products = [
      product({ priceMinCents: 1000, compareAtMaxCents: 2000 }), // 50% off
      product({ priceMinCents: 1000, compareAtMaxCents: null }), // not discounted — must not dilute the average
    ];
    const result = computeCatalogComposition(products);
    expect(result.discountDepth.averageDiscountPercent).toBe(50);
  });
});

describe("computeCatalogComposition — vendor/product-type mix", () => {
  it("counts occurrences and sorts descending by count", () => {
    const products = [
      product({ vendor: "Acme" }),
      product({ vendor: "Acme" }),
      product({ vendor: "Beta" }),
      product({ vendor: null }), // no vendor — excluded, not counted as "null"
    ];
    const result = computeCatalogComposition(products);
    expect(result.vendorMix).toEqual([
      { label: "Acme", count: 2 },
      { label: "Beta", count: 1 },
    ]);
  });

  it("caps at MAX_MIX_ENTRIES, keeping only the top entries", () => {
    const products = Array.from({ length: 12 }, (_, i) =>
      product({ productType: `Type${i}` }),
    );
    const result = computeCatalogComposition(products);
    expect(result.productTypeMix.length).toBeLessThanOrEqual(8);
  });

  it("returns an empty mix, not a crash, when no product has a vendor/type at all", () => {
    const result = computeCatalogComposition([product(), product()]);
    expect(result.vendorMix).toEqual([]);
    expect(result.productTypeMix).toEqual([]);
  });
});
