import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCatalogGrowthTrend, MIN_CRAWLS_FOR_CATALOG_TREND } from "../catalog";

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
  return prisma.store.create({ data: { domain: `catalog-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
// finishedAt is what catalog.ts actually samples (see its module doc:
// firstSeenAt/missingSince share finishedAt's "now", never startedAt's
// earlier one) — startedAt is set a beat earlier here specifically so a
// regression that reverts to comparing startedAt would fail these tests.
async function makeCrawl(storeId: string, finishedAt: Date) {
  return prisma.crawl.create({
    data: { storeId, status: "OK", startedAt: new Date(finishedAt.getTime() - 1000), finishedAt },
  });
}
async function makeProduct(
  storeId: string,
  externalId: string,
  firstSeenAt: Date,
  missingSince: Date | null = null,
  sourceCreatedAt: Date | null = null,
) {
  return prisma.product.create({
    data: {
      storeId,
      externalId,
      handle: externalId,
      title: externalId,
      priceMinCents: 1000,
      priceMaxCents: 1000,
      firstSeenAt,
      missingSince,
      sourceCreatedAt,
    },
  });
}

const D = (s: string) => new Date(s);

describe("getCatalogGrowthTrend — real Postgres", () => {
  it("returns INSUFFICIENT_HISTORY below MIN_CRAWLS_FOR_CATALOG_TREND real crawls", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, D("2026-08-01"));

    const result = await getCatalogGrowthTrend(prisma, store.id);
    expect(result.status).toBe("INSUFFICIENT_HISTORY");
  });

  it("reconstructs a real growth curve from Product.firstSeenAt/missingSince — no snapshot table involved", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, D("2026-01-01"));
    await makeCrawl(store.id, D("2026-02-01"));
    await makeCrawl(store.id, D("2026-03-01"));
    await makeCrawl(store.id, D("2026-04-01"));

    await makeProduct(store.id, "p1", D("2026-01-01"));
    await makeProduct(store.id, "p2", D("2026-02-01"));
    await makeProduct(store.id, "p3", D("2026-03-01"), D("2026-03-15")); // added then removed before the next sample

    const result = await getCatalogGrowthTrend(prisma, store.id);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.points.map((p) => p.size)).toEqual([1, 2, 3, 2]);
    expect(result.sampledFromCrawlCount).toBe(4);
  });

  it("respects MIN_CRAWLS_FOR_CATALOG_TREND as the real boundary", async () => {
    const store = await makeStore();
    for (let i = 0; i < MIN_CRAWLS_FOR_CATALOG_TREND; i++) {
      await makeCrawl(store.id, new Date(D("2026-01-01").getTime() + i * 86_400_000));
    }
    await makeProduct(store.id, "p1", D("2025-01-01"));

    const result = await getCatalogGrowthTrend(prisma, store.id);
    expect(result.status).toBe("OBSERVED");
  });

  it("a FAILED crawl never counts toward the trend", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, D("2026-01-01"));
    await makeCrawl(store.id, D("2026-02-01"));
    await prisma.crawl.create({ data: { storeId: store.id, status: "FAILED", startedAt: D("2026-03-01") } });

    const result = await getCatalogGrowthTrend(prisma, store.id);
    expect(result.status).toBe("INSUFFICIENT_HISTORY"); // only 2 real crawls, below MIN_CRAWLS_FOR_CATALOG_TREND
  });

  it("regression: a product's discovering crawl counts it as present, using that crawl's finishedAt not its earlier startedAt", async () => {
    const store = await makeStore();
    const crawl3Finish = D("2026-03-01");
    await makeCrawl(store.id, D("2026-01-01"));
    await makeCrawl(store.id, D("2026-02-01"));
    await makeCrawl(store.id, crawl3Finish);

    // firstSeenAt exactly equals the discovering crawl's finishedAt (the
    // real invariant) — that crawl's own startedAt is a full second earlier.
    await makeProduct(store.id, "p1", crawl3Finish);

    const result = await getCatalogGrowthTrend(prisma, store.id);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    // The product must already be counted at the exact date of its own discovery.
    expect(result.points.map((p) => p.size)).toEqual([0, 0, 1]);
  });

  describe("reconstruction from sourceCreatedAt — below MIN_CRAWLS_FOR_CATALOG_TREND", () => {
    it("a SINGLE real crawl still produces a real growth curve when products carry a launch date", async () => {
      const store = await makeStore();
      await makeCrawl(store.id, D("2026-06-01"));

      // All three products were discovered on the same (only) crawl, but
      // their real Shopify launch dates span two years — this is exactly
      // the "single analyze, full history" case.
      await makeProduct(store.id, "p1", D("2026-06-01"), null, D("2024-01-01"));
      await makeProduct(store.id, "p2", D("2026-06-01"), null, D("2025-01-01"));
      await makeProduct(store.id, "p3", D("2026-06-01"), null, D("2026-01-01"));

      const result = await getCatalogGrowthTrend(prisma, store.id);
      expect(result.status).toBe("OBSERVED");
      if (result.status !== "OBSERVED") throw new Error("unreachable");
      expect(result.reconstructedFromLaunchDates).toBe(true);
      expect(result.sampledFromCrawlCount).toBe(1);
      // Monotonically increasing from 0 up to 3 as each product's real launch date passes.
      expect(result.points[0].size).toBe(1); // sampling starts AT the earliest launch date itself
      expect(result.points[result.points.length - 1].size).toBe(3);
      expect(result.points.every((p, i) => i === 0 || p.size >= result.points[i - 1].size)).toBe(true);
    });

    it("falls back to INSUFFICIENT_HISTORY when no visible product carries a launch date", async () => {
      const store = await makeStore();
      await makeCrawl(store.id, D("2026-06-01"));
      await makeProduct(store.id, "p1", D("2026-06-01")); // no sourceCreatedAt

      const result = await getCatalogGrowthTrend(prisma, store.id);
      expect(result.status).toBe("INSUFFICIENT_HISTORY");
    });

    it("degrades gracefully: a product missing sourceCreatedAt still counts, using firstSeenAt instead", async () => {
      const store = await makeStore();
      await makeCrawl(store.id, D("2026-06-01"));
      await makeProduct(store.id, "dated", D("2026-06-01"), null, D("2024-01-01"));
      await makeProduct(store.id, "undated", D("2026-06-01")); // no sourceCreatedAt — falls back to firstSeenAt

      const result = await getCatalogGrowthTrend(prisma, store.id);
      expect(result.status).toBe("OBSERVED");
      if (result.status !== "OBSERVED") throw new Error("unreachable");
      // The undated product only counts once its firstSeenAt (the single
      // crawl date) is reached — at the very last sampled point.
      expect(result.points[result.points.length - 1].size).toBe(2);
      expect(result.points[0].size).toBe(1);
    });

    it("real crawl-sampled trends (>= MIN_CRAWLS_FOR_CATALOG_TREND) are never marked reconstructed", async () => {
      const store = await makeStore();
      await makeCrawl(store.id, D("2026-01-01"));
      await makeCrawl(store.id, D("2026-02-01"));
      await makeCrawl(store.id, D("2026-03-01"));
      await makeProduct(store.id, "p1", D("2026-01-01"), null, D("2020-01-01"));

      const result = await getCatalogGrowthTrend(prisma, store.id);
      expect(result.status).toBe("OBSERVED");
      if (result.status !== "OBSERVED") throw new Error("unreachable");
      expect(result.reconstructedFromLaunchDates).toBe(false);
    });
  });
});
