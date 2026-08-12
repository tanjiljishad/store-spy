import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getBestsellerSignal, MAX_RANK_SNAPSHOTS } from "../bestseller";

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
  return prisma.store.create({ data: { domain: `bestseller-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
async function makeCrawl(storeId: string, startedAt: Date) {
  return prisma.crawl.create({ data: { storeId, status: "OK", startedAt } });
}
async function makeProduct(storeId: string, bestsellerRank: number | null) {
  return prisma.product.create({
    data: { storeId, externalId: "p1", handle: "widget", title: "Widget", priceMinCents: 1000, priceMaxCents: 1000, bestsellerRank },
  });
}
async function makeSnapshot(productId: string, crawlId: string, capturedAt: Date, bestsellerRank: number | null) {
  return prisma.productStateSnapshot.create({
    data: { productId, crawlId, capturedAt, priceMinCents: 1000, priceMaxCents: 1000, variantCount: 1, availableVariants: 1, bestsellerRank },
  });
}

const D = (s: string) => new Date(s);

describe("getBestsellerSignal — real Postgres", () => {
  it("reconstructs a real rank trajectory and movement from real ProductStateSnapshot rows", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, 11); // 0-indexed rank -> displayed as #12
    const c1 = await makeCrawl(store.id, D("2026-08-01"));
    const c2 = await makeCrawl(store.id, D("2026-08-03"));
    const c3 = await makeCrawl(store.id, D("2026-08-05"));
    const c4 = await makeCrawl(store.id, D("2026-08-08"));

    await makeSnapshot(product.id, c1.id, D("2026-08-01"), 54);
    await makeSnapshot(product.id, c2.id, D("2026-08-03"), 36);
    await makeSnapshot(product.id, c3.id, D("2026-08-05"), 20);
    await makeSnapshot(product.id, c4.id, D("2026-08-08"), 11);

    const result = await getBestsellerSignal(prisma, { id: product.id, bestsellerRank: product.bestsellerRank });
    expect(result.currentRank).toBe(11);
    expect(result.trajectory.map((t) => t.rank)).toEqual([54, 36, 20, 11]);
    expect(result.movement).toEqual({ previousRank: 20, currentRank: 11, delta: 9 });
    expect(result.momentum).toBe("IMPROVING");
  });

  it("bounds the trajectory at MAX_RANK_SNAPSHOTS even with far more real history", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, 0);
    const totalSnapshots = MAX_RANK_SNAPSHOTS + 10;
    for (let i = 0; i < totalSnapshots; i++) {
      const crawl = await makeCrawl(store.id, new Date(D("2026-01-01").getTime() + i * 86_400_000));
      await makeSnapshot(product.id, crawl.id, crawl.startedAt, totalSnapshots - i);
    }

    const result = await getBestsellerSignal(prisma, { id: product.id, bestsellerRank: product.bestsellerRank });
    expect(result.trajectory.length).toBe(MAX_RANK_SNAPSHOTS);
  });

  it("reconstructs a real DECLINING trajectory (Scenario D — declining store) without any sales/revenue language in the data itself", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, 58);
    const c1 = await makeCrawl(store.id, D("2026-08-01"));
    const c2 = await makeCrawl(store.id, D("2026-08-03"));
    const c3 = await makeCrawl(store.id, D("2026-08-05"));
    const c4 = await makeCrawl(store.id, D("2026-08-08"));

    await makeSnapshot(product.id, c1.id, D("2026-08-01"), 10);
    await makeSnapshot(product.id, c2.id, D("2026-08-03"), 25);
    await makeSnapshot(product.id, c3.id, D("2026-08-05"), 41);
    await makeSnapshot(product.id, c4.id, D("2026-08-08"), 58);

    const result = await getBestsellerSignal(prisma, { id: product.id, bestsellerRank: product.bestsellerRank });
    expect(result.momentum).toBe("DECLINING");
    expect(result.movement).toEqual({ previousRank: 41, currentRank: 58, delta: -17 });
    // The signal itself carries no interpretation — only numbers and a
    // direction label. Any "not sales data" framing lives in the UI layer
    // (GrowthIntelligence.tsx), never fabricated into the data here.
    expect(JSON.stringify(result)).not.toMatch(/sales|revenue/i);
  });

  it("a product never ranked has an empty trajectory and no movement", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, null);

    const result = await getBestsellerSignal(prisma, { id: product.id, bestsellerRank: product.bestsellerRank });
    expect(result.currentRank).toBeNull();
    expect(result.trajectory).toEqual([]);
    expect(result.movement).toBeNull();
    expect(result.momentum).toBeNull();
  });
});
