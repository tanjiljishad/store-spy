import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildGrowthReport, MAX_PRODUCT_HIGHLIGHTS } from "../report";

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
    `TRUNCATE "Event","ProductStateSnapshot","StoreEntity","Product","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore(overrides: Partial<{ baselinedAt: Date }> = {}) {
  return prisma.store.create({
    data: { domain: `growth-report-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY", baselinedAt: overrides.baselinedAt ?? new Date() },
  });
}
// finishedAt is what catalog.ts/persistence.ts actually read — see their
// module docs. startedAt is set a beat earlier, matching real production shape.
async function makeCrawl(storeId: string, finishedAt: Date) {
  return prisma.crawl.create({
    data: { storeId, status: "OK", startedAt: new Date(finishedAt.getTime() - 1000), finishedAt },
  });
}

const D = (s: string) => new Date(s);

describe("buildGrowthReport — real Postgres, end to end", () => {
  it("assembles catalog growth, review infrastructure, and product highlights from real data", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, D("2026-06-01"));
    await makeCrawl(store.id, D("2026-07-01"));
    await makeCrawl(store.id, D("2026-08-01"));

    await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "p1",
        handle: "widget",
        title: "Widget",
        priceMinCents: 1000,
        priceMaxCents: 1000,
        firstSeenAt: D("2026-06-01"),
        bestsellerRank: 4,
      },
    });
    await prisma.storeEntity.create({ data: { storeId: store.id, kind: "APP", key: "judgeme", status: "ACTIVE" } });

    const report = await buildGrowthReport(prisma, store.id, store.domain);

    expect(report.domain).toBe(store.domain);
    expect(report.catalogGrowth.currentProductCount).toBe(1);
    // Sub-phase D: exposed so StoreActivitySummary.tsx can be seeded from
    // this same report instead of its own separate /activity fetch.
    expect(report.catalogGrowth.priceChanges).toBe(0);
    expect(report.reviewInfrastructure.status).toBe("OBSERVED");
    expect(report.productHighlights).toHaveLength(1);
    expect(report.productHighlights[0].handle).toBe("widget");
    expect(report.productHighlights[0].bestseller.currentRank).toBe(4);
  });

  it("bounds product highlights at MAX_PRODUCT_HIGHLIGHTS, prioritizing ranked products", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, D("2026-06-01"));
    await makeCrawl(store.id, D("2026-07-01"));

    const totalProducts = MAX_PRODUCT_HIGHLIGHTS + 10;
    await prisma.product.createMany({
      data: Array.from({ length: totalProducts }, (_, i) => ({
        storeId: store.id,
        externalId: `p${i}`,
        handle: `p${i}`,
        title: `Product ${i}`,
        priceMinCents: 1000,
        priceMaxCents: 1000,
        firstSeenAt: D("2026-06-01"),
        // Only the first MAX_PRODUCT_HIGHLIGHTS get a real rank — the rest are unranked filler.
        bestsellerRank: i < MAX_PRODUCT_HIGHLIGHTS ? i : null,
      })),
    });

    const report = await buildGrowthReport(prisma, store.id, store.domain);

    expect(report.productHighlights).toHaveLength(MAX_PRODUCT_HIGHLIGHTS);
    expect(report.productHighlights.every((h) => h.bestseller.currentRank !== null)).toBe(true);
  });

  it("never crashes and returns honest UNAVAILABLE/INSUFFICIENT_HISTORY states for a freshly baselined store", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, D("2026-08-11"));

    const report = await buildGrowthReport(prisma, store.id, store.domain);

    expect(report.catalogGrowth.hasEnoughHistory).toBe(false);
    expect(report.catalogGrowth.trend.status).toBe("INSUFFICIENT_HISTORY");
    expect(report.reviewInfrastructure).toEqual({ status: "OBSERVED", value: [] });
    expect(report.productHighlights).toEqual([]);
  });
});
