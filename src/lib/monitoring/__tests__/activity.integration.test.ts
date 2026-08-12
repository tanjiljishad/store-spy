import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeGrowthSignals, getActivitySummary } from "../activity";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
}
if (!/test/i.test(url)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`,
  );
}

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore() {
  return prisma.store.create({ data: { domain: `activity-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
async function makeCrawl(storeId: string, startedAt: Date) {
  return prisma.crawl.create({ data: { storeId, status: "OK", startedAt } });
}
async function makeEvent(storeId: string, crawlId: string, eventType: string, occurredAt: Date) {
  return prisma.event.create({
    data: {
      storeId,
      crawlId,
      entityType: "PRODUCT",
      entityKey: randomUUID(),
      eventType: eventType as never,
      significance: 50,
      headline: "Test event",
      dedupeKey: randomUUID(),
      occurredAt,
    },
  });
}
async function makeProducts(storeId: string, count: number) {
  await prisma.product.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      storeId,
      externalId: `p${i}`,
      handle: `p${i}`,
      title: `Product ${i}`,
      priceMinCents: 1000,
      priceMaxCents: 1000,
    })),
  });
}

const NOW = new Date("2026-08-11T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("getActivitySummary — hasEnoughHistory gating", () => {
  it("is false with only one real crawl on record — the exact 'don't fake history' guard", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, days(1));

    const summary = await getActivitySummary(prisma, store.id, 7);

    expect(summary.hasEnoughHistory).toBe(false);
    expect(summary.productCountWindowAgo).toBeNull();
    expect(summary.productCountDelta).toBeNull();
  });

  it("is true once a second real crawl exists", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, days(2));
    await makeCrawl(store.id, days(1));

    const summary = await getActivitySummary(prisma, store.id, 7);

    expect(summary.hasEnoughHistory).toBe(true);
  });
});

describe("getActivitySummary — real counts, real window", () => {
  it("counts events precisely and excludes anything outside the window", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, days(10));
    const recentCrawl = await makeCrawl(store.id, days(1));
    await makeProducts(store.id, 10);

    // Inside the 7-day window
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_ADDED", days(3));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_ADDED", days(2));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_REMOVED", days(1));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_RESTORED", days(1));
    await makeEvent(store.id, recentCrawl.id, "PRICE_DROP", days(1));
    await makeEvent(store.id, recentCrawl.id, "SALE_STARTED", days(1));

    // Outside the window — must not be counted
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_ADDED", days(30));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_RESTORED", days(30));

    const summary = await getActivitySummary(prisma, store.id, 7);

    expect(summary.productsAdded).toBe(2);
    expect(summary.productsRemoved).toBe(1);
    expect(summary.productsRestored).toBe(1);
    expect(summary.priceChanges).toBe(2); // PRICE_DROP + SALE_STARTED
    // Unchanged formula — restorations are counted separately, never folded
    // into this pre-existing aggregate (see ActivitySummary's own doc comment).
    expect(summary.totalProductChanges).toBe(5);
    expect(summary.currentProductCount).toBe(10);
  });

  it("counts PRODUCT_RESTORED across multiple remove/restore flap cycles without double-counting", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, days(10));
    const recentCrawl = await makeCrawl(store.id, days(1));
    await makeProducts(store.id, 5);

    // Two separate flap cycles for the same product within the window.
    // Kept well clear of the 7-day boundary (unlike NOW, `since` below is
    // computed from the real wall clock at test-run time) so a few days'
    // drift between NOW and the actual run date can never push one of
    // these outside the window and flake this test.
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_REMOVED", days(4));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_RESTORED", days(3));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_REMOVED", days(2));
    await makeEvent(store.id, recentCrawl.id, "PRODUCT_RESTORED", days(1));

    const summary = await getActivitySummary(prisma, store.id, 7);

    expect(summary.productsRemoved).toBe(2);
    expect(summary.productsRestored).toBe(2);
  });
});

describe("computeGrowthSignals", () => {
  const base = {
    windowDays: 7,
    productsAdded: 0,
    productsRemoved: 0,
    productsRestored: 0,
    priceChanges: 0,
    totalProductChanges: 0,
    currentProductCount: 100,
    crawlsInWindow: 3,
    hasEnoughHistory: true,
  };

  it("returns nothing when there isn't enough history yet — never fabricate a signal", () => {
    const signals = computeGrowthSignals({ ...base, hasEnoughHistory: false, productCountWindowAgo: null, productCountDelta: null, productCountDeltaPct: null });
    expect(signals).toHaveLength(0);
  });

  it("reports CATALOG_EXPANSION on real net growth", () => {
    const signals = computeGrowthSignals({ ...base, productCountWindowAgo: 90, productCountDelta: 10, productCountDeltaPct: 11.1 });
    expect(signals.map((s) => s.kind)).toContain("CATALOG_EXPANSION");
  });

  it("reports CATALOG_CONTRACTION on real net shrinkage", () => {
    const signals = computeGrowthSignals({ ...base, productCountWindowAgo: 110, productCountDelta: -10, productCountDeltaPct: -9.1 });
    expect(signals.map((s) => s.kind)).toContain("CATALOG_CONTRACTION");
  });

  it("reports PRICE_ACTIVITY when price changes were observed", () => {
    const signals = computeGrowthSignals({ ...base, priceChanges: 4, productCountWindowAgo: 100, productCountDelta: 0, productCountDeltaPct: 0 });
    expect(signals.map((s) => s.kind)).toContain("PRICE_ACTIVITY");
  });

  it("reports STEADY when genuinely nothing moved", () => {
    const signals = computeGrowthSignals({ ...base, productCountWindowAgo: 100, productCountDelta: 0, productCountDeltaPct: 0 });
    expect(signals.map((s) => s.kind)).toEqual(["STEADY"]);
  });

  it("every signal states its own evidence — deterministic, not a vague score", () => {
    const signals = computeGrowthSignals({ ...base, productCountWindowAgo: 90, productCountDelta: 10, productCountDeltaPct: 11.1, priceChanges: 3 });
    for (const s of signals) {
      expect(s.detail).toMatch(/\d/); // always cites a real number, never just an adjective
    }
  });
});
