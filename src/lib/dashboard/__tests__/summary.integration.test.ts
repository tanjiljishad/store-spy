import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDashboardSummary } from "../summary";
import { startMonitoring } from "../../monitoring/watch";

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
    `TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeUser(plan: "FREE" | "BASIC" = "FREE") {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan } });
}
async function makeStoreWithProducts(domain: string, count: number) {
  const store = await prisma.store.create({ data: { domain, platform: "SHOPIFY" } });
  await prisma.product.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      storeId: store.id,
      externalId: `p${i}`,
      handle: `p${i}`,
      title: `Product ${i}`,
      priceMinCents: 1000,
      priceMaxCents: 1000,
    })),
  });
  return store;
}

const NOW = new Date("2026-08-11T12:00:00Z");

describe("getDashboardSummary — FREE plan", () => {
  it("reports zero usage and no monitoring for a brand-new user — honestly empty, not an error", async () => {
    const user = await makeUser();
    const summary = await getDashboardSummary(prisma, user.id, NOW);

    expect(summary.plan).toBe("FREE");
    expect(summary.analyses).toEqual({ used: 0, limit: 3, stores: [] });
    expect(summary.monitoring).toEqual({ active: [], slotsUsed: 0, slotsLimit: 1 });
  });

  it("reflects real analyzed-store data, including real product counts", async () => {
    const user = await makeUser();
    const store = await makeStoreWithProducts("dash-store.com", 42);
    await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });

    const summary = await getDashboardSummary(prisma, user.id, NOW);

    expect(summary.analyses.used).toBe(1);
    expect(summary.analyses.stores).toEqual([{ domain: "dash-store.com", productCount: 42, analyzedAt: expect.any(String) }]);
  });

  it("reflects a single active watch with the correct days-remaining math", async () => {
    const user = await makeUser();
    const store = await makeStoreWithProducts("watched-store.com", 5);
    await startMonitoring(prisma, user.id, store.id, "FREE", NOW);

    const summary = await getDashboardSummary(prisma, user.id, NOW);

    expect(summary.monitoring.active).toHaveLength(1);
    expect(summary.monitoring.active[0]).toMatchObject({ domain: "watched-store.com", daysRemaining: 30 });
    expect(summary.monitoring.slotsUsed).toBe(1);
  });

  it("user isolation: one user's dashboard never reflects another user's usage or monitoring", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const storeA = await makeStoreWithProducts("store-a.com", 10);
    const storeB = await makeStoreWithProducts("store-b.com", 20);
    await prisma.analysisUsage.create({ data: { userId: userA.id, storeId: storeA.id } });
    await startMonitoring(prisma, userA.id, storeA.id, "FREE", NOW);
    await prisma.analysisUsage.create({ data: { userId: userB.id, storeId: storeB.id } });

    const summaryA = await getDashboardSummary(prisma, userA.id, NOW);
    const summaryB = await getDashboardSummary(prisma, userB.id, NOW);

    expect(summaryA.analyses.stores.map((s) => s.domain)).toEqual(["store-a.com"]);
    expect(summaryB.analyses.stores.map((s) => s.domain)).toEqual(["store-b.com"]);
    expect(summaryB.monitoring.active).toEqual([]); // userB never touched monitoring
  });
});

describe("getDashboardSummary — BASIC plan", () => {
  it("represents unlimited analyses as limit: null, never a large number", async () => {
    const user = await makeUser("BASIC");
    const summary = await getDashboardSummary(prisma, user.id, NOW);

    expect(summary.analyses.limit).toBeNull();
    expect(summary.monitoring.slotsLimit).toBe(20);
  });

  it("lists multiple simultaneous active watches, each with continuous (null) expiry", async () => {
    const user = await makeUser("BASIC");
    const storeA = await makeStoreWithProducts("multi-a.com", 3);
    const storeB = await makeStoreWithProducts("multi-b.com", 7);
    await startMonitoring(prisma, user.id, storeA.id, "BASIC", NOW);
    await startMonitoring(prisma, user.id, storeB.id, "BASIC", NOW);

    const summary = await getDashboardSummary(prisma, user.id, NOW);

    expect(summary.monitoring.slotsUsed).toBe(2);
    expect(summary.monitoring.active).toHaveLength(2);
    const domains = summary.monitoring.active.map((w) => w.domain).sort();
    expect(domains).toEqual(["multi-a.com", "multi-b.com"]);
    for (const watch of summary.monitoring.active) {
      expect(watch.expiresAt).toBeNull();
      expect(watch.daysRemaining).toBeNull();
    }
  });
});
