import { describe, expect, it } from "vitest";
import type {
  NormalizedProduct,
  NormalizedStoreSnapshot,
  PreviousEntityState,
  PreviousProductState,
  StoreContext,
} from "../../crawl/types";
import { diffStore } from "../engine";

const NOW = new Date("2026-08-08T12:00:00Z");

function entity(overrides: Partial<PreviousEntityState> = {}): PreviousEntityState {
  return {
    id: "ent_1",
    kind: "COLLECTION",
    key: "all",
    meta: null,
    status: "ACTIVE",
    missingStreak: 0,
    missingSince: null,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function store(overrides: Partial<StoreContext> = {}): StoreContext {
  return {
    id: "store_1",
    domain: "example.com",
    currency: "USD",
    baselinedAt: new Date("2026-01-01T00:00:00Z"),
    themeName: "Dawn",
    themeVersion: "15.0.0",
    entities: [
      entity({ id: "ent_collection_all", kind: "COLLECTION", key: "all" }),
      entity({ id: "ent_app_klaviyo", kind: "APP", key: "klaviyo" }),
      entity({ id: "ent_pixel_facebook", kind: "PIXEL", key: "facebook", meta: { id: "111" } }),
    ],
    stats: {
      priceChangesInWindow: 2,
      productsAddedInWindow: 3,
      crawlsInWindow: 30,
      productCount: 100,
      medianPriceCents: 4999,
    },
    ...overrides,
  };
}

function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    externalId: "p1",
    handle: "widget",
    title: "Widget",
    vendor: "Acme",
    productType: "Gadget",
    tags: [],
    sourceCreatedAt: new Date("2026-06-01T00:00:00Z"),
    publishedAt: new Date("2026-06-01T00:00:00Z"),
    priceMinCents: 7900,
    priceMaxCents: 7900,
    compareAtMaxCents: null,
    variantCount: 3,
    availableVariants: 3,
    variants: [],
    bestsellerRank: 2,
    imageHash: null,
    ...overrides,
  };
}

function prev(overrides: Partial<PreviousProductState> = {}): PreviousProductState {
  return {
    id: "row_1",
    externalId: "p1",
    handle: "widget",
    title: "Widget",
    status: "ACTIVE",
    priceMinCents: 7900,
    priceMaxCents: 7900,
    compareAtMaxCents: null,
    variantCount: 3,
    availableVariants: 3,
    bestsellerRank: 2,
    missingStreak: 0,
    missingSince: null,
    firstSeenAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function snap(
  products: NormalizedProduct[],
  overrides: Partial<NormalizedStoreSnapshot> = {},
): NormalizedStoreSnapshot {
  return {
    domain: "example.com",
    currency: "USD",
    products,
    collectionHandles: ["all"],
    hasCollectionData: true,
    tech: null,
    // false by default, paired with tech: null — mirrors the old code's
    // `if (!tech) return events` skip, so default fixtures don't newly
    // fire APP/PIXEL events that were never exercised before.
    hasTechData: false,
    partial: false,
    pagesExpected: 1,
    pagesFetched: 1,
    httpErrors: 0,
    hasRankData: true,
    capturedAt: NOW,
    ...overrides,
  };
}

const types = (r: { events: Array<{ eventType: string }> }) => r.events.map((e) => e.eventType);

describe("baseline crawl", () => {
  it("emits no alertable events and backfills history from source timestamps", () => {
    const r = diffStore({
      store: store({ baselinedAt: null }),
      previous: [],
      snapshot: snap([product({ externalId: "a" }), product({ externalId: "b" })]),
      now: NOW,
    });

    expect(r.isBaseline).toBe(true);
    expect(r.events.filter((e) => !e.backfilled && e.eventType === "PRODUCT_ADDED")).toHaveLength(0);
    expect(r.events.filter((e) => e.backfilled)).toHaveLength(2);
    // Backfilled events carry the real launch date, not the crawl date.
    expect(r.events.find((e) => e.backfilled)?.occurredAt.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });
});

describe("removal guards", () => {
  it("does not confirm removal on the first absence", () => {
    const r = diffStore({
      store: store(),
      previous: [prev()],
      snapshot: snap([]),
      now: NOW,
      config: { minProductsForShrinkCheck: 1000 }, // isolate from shrink guard
    });

    expect(types(r)).not.toContain("PRODUCT_REMOVED");
    expect(r.upserts[0].status).toBe("MISSING");
    expect(r.upserts[0].missingStreak).toBe(1);
  });

  it("confirms removal once the streak threshold is reached", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ status: "MISSING", missingStreak: 1 })],
      snapshot: snap([]),
      now: NOW,
      config: { minProductsForShrinkCheck: 1000 },
    });

    expect(types(r)).toContain("PRODUCT_REMOVED");
    expect(r.upserts[0].status).toBe("REMOVED");
  });

  it("never advances the missing streak on a partial crawl", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ status: "MISSING", missingStreak: 1 })],
      snapshot: snap([], { partial: true, httpErrors: 1 }),
      now: NOW,
      config: { minProductsForShrinkCheck: 1000 },
    });

    expect(types(r)).not.toContain("PRODUCT_REMOVED");
    expect(r.upserts).toHaveLength(0);
  });

  it("aborts entirely when the catalog appears to collapse", () => {
    const previous = Array.from({ length: 100 }, (_, i) => prev({ id: `r${i}`, externalId: `p${i}` }));
    const r = diffStore({
      store: store(),
      previous,
      snapshot: snap([product({ externalId: "p0" })]),
      now: NOW,
    });

    expect(r.aborted).toBe(true);
    expect(r.events).toHaveLength(0);
    expect(r.abortReason).toContain("shrank");
  });
});

describe("price diffing", () => {
  it("ignores sub-threshold noise", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ priceMinCents: 7900 })],
      snapshot: snap([product({ priceMinCents: 7910 })]), // 0.13%, 10 cents
      now: NOW,
    });
    expect(types(r)).toHaveLength(0);
  });

  it("emits PRICE_DROP on a real move", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ priceMinCents: 7900 })],
      snapshot: snap([product({ priceMinCents: 5900 })]),
      now: NOW,
    });

    expect(types(r)).toContain("PRICE_DROP");
    expect(r.events[0].headline).toContain("$79.00");
    expect(r.events[0].headline).toContain("$59.00");
  });

  it("distinguishes a sale from a repricing", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ priceMinCents: 7900, compareAtMaxCents: null })],
      snapshot: snap([product({ priceMinCents: 5900, compareAtMaxCents: 7900 })]),
      now: NOW,
    });

    expect(types(r)).toContain("SALE_STARTED");
    expect(types(r)).not.toContain("PRICE_DROP");
  });

  it("amplifies significance when other stores make the same move", () => {
    const base = {
      store: store(),
      previous: [prev({ priceMinCents: 7900 })],
      snapshot: snap([product({ priceMinCents: 5900 })]),
      now: NOW,
    };
    const solo = diffStore(base);
    const market = diffStore({ ...base, crossStoreCounts: new Map([["p1", 9]]) });

    expect(market.events[0].significance).toBeGreaterThan(solo.events[0].significance);
  });
});

describe("availability and rank", () => {
  it("flags a full sell-out as high significance", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ availableVariants: 3 })],
      snapshot: snap([product({ availableVariants: 0 })]),
      now: NOW,
    });

    expect(types(r)).toContain("PRODUCT_SOLD_OUT");
    expect(r.events[0].significance).toBeGreaterThan(60);
  });

  it("ignores rank data entirely when the ranking crawl failed", () => {
    const r = diffStore({
      store: store(),
      previous: [prev({ bestsellerRank: 2 })],
      snapshot: snap([product({ bestsellerRank: null })], { hasRankData: false }),
      now: NOW,
    });
    expect(types(r)).not.toContain("BESTSELLER_DROPPED");
  });
});

describe("bulk operations", () => {
  it("caps alerts and reports the remainder", () => {
    const previous = Array.from({ length: 300 }, (_, i) => prev({ id: `r${i}`, externalId: `p${i}` }));
    const products = previous.map((p, i) =>
      product({ externalId: p.externalId, priceMinCents: 3900, bestsellerRank: i }),
    );

    const r = diffStore({
      store: store(),
      previous,
      snapshot: snap(products),
      now: NOW,
      config: { maxEventsPerCrawl: 50 },
    });

    expect(r.events).toHaveLength(50);
    expect(r.suppressedCount).toBe(250);
    // Survivors are the most significant, not the first encountered.
    expect(r.events[0].significance).toBeGreaterThanOrEqual(r.events[49].significance);
  });
});

describe("idempotency", () => {
  it("produces identical dedupe keys for identical inputs", () => {
    const args = {
      store: store(),
      previous: [prev({ priceMinCents: 7900 })],
      snapshot: snap([product({ priceMinCents: 5900 })]),
      now: NOW,
    };
    expect(diffStore(args).events[0].dedupeKey).toBe(diffStore(args).events[0].dedupeKey);
  });
});
