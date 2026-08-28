import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDailyAnalysesTrend, getUsageCostMetrics } from "../usage-cost";
import { SERPAPI_COST_PER_CALL_CENTS } from "../vendor-cost";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MarketingCollectionRun","Watchlist","AnalysisUsage","Crawl","Session","Account","Store","User" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-08T00:00:00Z");
const INSIDE = new Date("2026-08-05T12:00:00Z");
const OUTSIDE = new Date("2026-07-20T12:00:00Z");

async function makeUser(plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan });
}
async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("getUsageCostMetrics", () => {
  it("groups analyses in the window by the analyzing user's CURRENT plan", async () => {
    const freeUser = await makeUser("FREE");
    const businessUser = await makeUser("BUSINESS");
    const store = await makeStore();
    for (const [user, count] of [[freeUser, 2], [businessUser, 3]] as const) {
      for (let i = 0; i < count; i++) {
        const row = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
        await prisma.analysisUsage.update({ where: { id: row.id }, data: { createdAt: INSIDE } });
      }
    }

    const metrics = await getUsageCostMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.analysesByPlan).toEqual({ FREE: 2, BASIC: 0, BUSINESS: 3 });
  });

  it("computes crawl failure rate as FAILED / total crawls started in the window", async () => {
    const store = await makeStore();
    for (const status of ["OK", "OK", "OK", "FAILED"] as const) {
      await prisma.crawl.create({ data: { storeId: store.id, status, startedAt: INSIDE } });
    }
    await prisma.crawl.create({ data: { storeId: store.id, status: "FAILED", startedAt: OUTSIDE } }); // outside window, must not count

    const metrics = await getUsageCostMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.crawlVolume).toBe(4);
    expect(metrics.crawlFailures).toBe(1);
    expect(metrics.crawlFailureRate).toBeCloseTo(0.25, 5);
  });

  it("sums SerpAPI vendor request count in the window into a real cost figure", async () => {
    const store = await makeStore();
    const run1 = await prisma.marketingCollectionRun.create({ data: { storeId: store.id, platform: "GOOGLE", vendorRequestCount: 2 } });
    await prisma.marketingCollectionRun.update({ where: { id: run1.id }, data: { startedAt: INSIDE } });
    const run2 = await prisma.marketingCollectionRun.create({ data: { storeId: store.id, platform: "GOOGLE", vendorRequestCount: 5 } });
    await prisma.marketingCollectionRun.update({ where: { id: run2.id }, data: { startedAt: OUTSIDE } }); // must not count

    const metrics = await getUsageCostMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.serpApiCalls).toBe(2);
    expect(metrics.serpApiCostCents).toBeCloseTo(2 * SERPAPI_COST_PER_CALL_CENTS, 5);
  });

  it("cost per active BUSINESS account divides SerpAPI cost of BUSINESS-watched stores by the count of distinct active BUSINESS watchers", async () => {
    const businessUser1 = await makeUser("BUSINESS");
    const businessUser2 = await makeUser("BUSINESS");
    const freeUser = await makeUser("FREE");
    const businessStore = await makeStore();
    const freeStore = await makeStore();
    const unwatchedStore = await makeStore();

    // Two BUSINESS accounts, but they share ONE watched store — its cost must be counted ONCE, not twice.
    await prisma.watchlist.create({ data: { userId: businessUser1.id, storeId: businessStore.id, monitoringStatus: "ACTIVE" } });
    await prisma.watchlist.create({ data: { userId: businessUser2.id, storeId: businessStore.id, monitoringStatus: "ACTIVE" } });
    await prisma.watchlist.create({ data: { userId: freeUser.id, storeId: freeStore.id, monitoringStatus: "ACTIVE" } });

    const businessRun = await prisma.marketingCollectionRun.create({ data: { storeId: businessStore.id, platform: "GOOGLE", vendorRequestCount: 10 } });
    await prisma.marketingCollectionRun.update({ where: { id: businessRun.id }, data: { startedAt: INSIDE } });
    const freeRun = await prisma.marketingCollectionRun.create({ data: { storeId: freeStore.id, platform: "GOOGLE", vendorRequestCount: 40 } });
    await prisma.marketingCollectionRun.update({ where: { id: freeRun.id }, data: { startedAt: INSIDE } });
    const unwatchedRun = await prisma.marketingCollectionRun.create({ data: { storeId: unwatchedStore.id, platform: "GOOGLE", vendorRequestCount: 99 } });
    await prisma.marketingCollectionRun.update({ where: { id: unwatchedRun.id }, data: { startedAt: INSIDE } });

    const metrics = await getUsageCostMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.activeBusinessAccountCount).toBe(2);
    expect(metrics.businessWatchedSerpApiCalls).toBe(10); // not 20 — the shared store's cost counted once
    expect(metrics.costPerActiveBusinessAccountCents).toBeCloseTo((10 * SERPAPI_COST_PER_CALL_CENTS) / 2, 5);
  });

  it("zero crawls / zero business accounts yields null rates, not division by zero", async () => {
    const metrics = await getUsageCostMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.crawlFailureRate).toBeNull();
    expect(metrics.costPerActiveBusinessAccountCents).toBeNull();
  });
});

describe("getDailyAnalysesTrend", () => {
  it("buckets analyses into UTC calendar days, split by the analyzing user's plan", async () => {
    const freeUser = await makeUser("FREE");
    const store = await makeStore();
    const now = new Date("2026-08-10T15:00:00Z");
    const day1 = new Date("2026-08-08T10:00:00Z");
    const day2 = new Date("2026-08-09T10:00:00Z");

    for (const day of [day1, day2]) {
      const row = await prisma.analysisUsage.create({ data: { userId: freeUser.id, storeId: store.id } });
      await prisma.analysisUsage.update({ where: { id: row.id }, data: { createdAt: day } });
    }

    const trend = await getDailyAnalysesTrend(prisma, 5, now);
    expect(trend).toHaveLength(2);
    expect(trend[0].day.toISOString()).toBe("2026-08-08T00:00:00.000Z");
    expect(trend[0].count).toBe(1);
    expect(trend[0].plan).toBe("FREE");
  });
});
