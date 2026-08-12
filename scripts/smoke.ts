/**
 * Smoke test: drives diffStore() across a two-crawl sequence for a fake
 * store, with no database involved. Exercises baseline, then a second
 * crawl carrying a price drop, a sale, a sell-out, and a removal.
 */
import { normalizeSnapshot } from "../src/lib/crawl/normalize";
import type { PreviousProductState, StoreContext } from "../src/lib/crawl/types";
import { diffStore } from "../src/lib/diff/engine";

const store: StoreContext = {
  id: "store_1",
  domain: "example-store.myshopify.com",
  currency: "USD",
  baselinedAt: null,
  themeName: null,
  themeVersion: null,
  entities: [],
  stats: null,
};

const rawProducts = [
  {
    id: 1,
    handle: "classic-tee",
    title: "Classic Tee",
    vendor: "Acme",
    product_type: "Apparel",
    tags: "bestseller,cotton",
    created_at: "2026-05-01T00:00:00Z",
    published_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    variants: [
      { id: 11, title: "S", sku: "TEE-S", price: "29.00", compare_at_price: null, available: true, position: 1 },
      { id: 12, title: "M", sku: "TEE-M", price: "29.00", compare_at_price: null, available: true, position: 2 },
    ],
  },
  {
    id: 2,
    handle: "denim-jacket",
    title: "Denim Jacket",
    vendor: "Acme",
    product_type: "Outerwear",
    tags: "new",
    created_at: "2026-05-02T00:00:00Z",
    published_at: "2026-05-02T00:00:00Z",
    updated_at: "2026-05-02T00:00:00Z",
    variants: [
      { id: 21, title: "One Size", sku: "JKT-1", price: "120.00", compare_at_price: null, available: true, position: 1 },
    ],
  },
];

// --- Crawl 1: baseline ------------------------------------------------------

const snapshot1 = normalizeSnapshot({
  domain: store.domain,
  currency: "USD",
  rawProducts,
  bestsellerRanks: new Map([["1", 0]]),
  pagesExpected: 1,
  pagesFetched: 1,
  httpErrors: 0,
  capturedAt: new Date("2026-08-01T00:00:00Z"),
});

const baseline = diffStore({ store, previous: [], snapshot: snapshot1, now: new Date("2026-08-01T00:00:00Z") });

console.log("=== Crawl 1 (baseline) ===");
console.log("isBaseline:", baseline.isBaseline);
console.log("events:", baseline.events.map((e) => `${e.eventType} — ${e.headline}`));
console.log("upserts:", baseline.upserts.length);

// --- Crawl 2: price drop + sell-out + removal -------------------------------

const previous: PreviousProductState[] = baseline.upserts.map((u) => ({
  id: `row_${u.externalId}`,
  externalId: u.externalId,
  handle: u.handle,
  title: u.title,
  status: u.status,
  priceMinCents: u.priceMinCents,
  priceMaxCents: u.priceMaxCents,
  compareAtMaxCents: u.compareAtMaxCents,
  variantCount: u.variantCount,
  availableVariants: u.availableVariants,
  bestsellerRank: u.bestsellerRank,
  missingStreak: u.missingStreak,
  missingSince: u.missingSince,
  firstSeenAt: new Date("2026-08-01T00:00:00Z"),
}));

const rawProducts2 = [
  {
    ...rawProducts[0],
    variants: [
      { id: 11, title: "S", sku: "TEE-S", price: "19.00", compare_at_price: "29.00", available: true, position: 1 },
      { id: 12, title: "M", sku: "TEE-M", price: "19.00", compare_at_price: "29.00", available: false, position: 2 },
    ],
  },
  // denim-jacket (id 2) is gone this crawl -> MISSING streak 1
];

const storeAfterBaseline: StoreContext = { ...store, baselinedAt: new Date("2026-08-01T00:00:00Z") };

const snapshot2 = normalizeSnapshot({
  domain: store.domain,
  currency: "USD",
  rawProducts: rawProducts2,
  bestsellerRanks: new Map([["1", 0]]),
  pagesExpected: 1,
  pagesFetched: 1,
  httpErrors: 0,
  capturedAt: new Date("2026-08-08T00:00:00Z"),
});

const crawl2 = diffStore({
  store: storeAfterBaseline,
  previous,
  snapshot: snapshot2,
  now: new Date("2026-08-08T00:00:00Z"),
});

console.log("\n=== Crawl 2 (sale + sell-out + missing product) ===");
console.log(
  "events:",
  crawl2.events.map((e) => `[${e.significance}] ${e.eventType} — ${e.headline}`),
);
console.log(
  "upserts:",
  crawl2.upserts.map((u) => `${u.title}: ${u.status} (missingStreak=${u.missingStreak})`),
);
console.log("suppressedCount:", crawl2.suppressedCount);
