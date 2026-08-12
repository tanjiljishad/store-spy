import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildMarketingReport } from "../report";

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
    `TRUNCATE "Event","AdObservation","MarketingCollectionRun","Product","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore() {
  return prisma.store.create({ data: { domain: `test-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("buildMarketingReport — the OBSERVED/UNAVAILABLE contract", () => {
  it("a store never checked returns UNAVAILABLE, not an empty array", async () => {
    const store = await makeStore();
    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads.status).toBe("UNAVAILABLE");
    expect(report.lastCheckedAt).toBeNull();
  });

  it("a store successfully checked with zero ads returns OBSERVED [] — the honest 'checked, none found' case", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 0, finishedAt: new Date() },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads).toEqual({ status: "OBSERVED", value: [] });
    expect(report.lastCheckedAt).not.toBeNull();
  });

  it("a store whose last check failed returns UNAVAILABLE with the real reason, never an empty array", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: {
        storeId: store.id,
        platform: "GOOGLE",
        outcome: "UNAVAILABLE",
        reason: "vendor 503",
        finishedAt: new Date(),
      },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads).toEqual({ status: "UNAVAILABLE", reason: "vendor 503" });
  });

  it("a store with active ads returns them as OBSERVED, excluding HISTORICAL ones", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 2, finishedAt: new Date() },
    });
    await prisma.adObservation.create({
      data: {
        storeId: store.id,
        platform: "GOOGLE",
        externalAdId: "CR001",
        status: "ACTIVE_EVIDENCE",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
      },
    });
    await prisma.adObservation.create({
      data: {
        storeId: store.id,
        platform: "GOOGLE",
        externalAdId: "CR002",
        status: "HISTORICAL",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
      },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads.status).toBe("OBSERVED");
    if (report.ads.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.ads.value).toHaveLength(1);
    expect(report.ads.value[0].externalAdId).toBe("CR001");
  });

  it("a run that never finished (outcome still null) is UNAVAILABLE, not silently ignored", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({ data: { storeId: store.id, platform: "GOOGLE" } });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads.status).toBe("UNAVAILABLE");
  });
});

describe("buildMarketingReport — Sub-phase E: explicit epistemic fields", () => {
  it("productMatching, adSpend, impressions, and conversions are ALWAYS UNAVAILABLE with real, specific reasons — regardless of ads status", async () => {
    const neverChecked = await makeStore();
    const reportA = await buildMarketingReport(prisma, neverChecked.id, neverChecked.domain);
    expect(reportA.productMatching).toEqual({
      status: "UNAVAILABLE",
      reason: "Product-level matching unavailable from the current advertising data source.",
    });
    expect(reportA.adSpend.status).toBe("UNAVAILABLE");
    expect(reportA.impressions.status).toBe("UNAVAILABLE");
    expect(reportA.conversions.status).toBe("UNAVAILABLE");

    const checkedWithAds = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: checkedWithAds.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 1, finishedAt: new Date() },
    });
    await prisma.adObservation.create({
      data: {
        storeId: checkedWithAds.id,
        platform: "GOOGLE",
        externalAdId: "CR001",
        status: "ACTIVE_EVIDENCE",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
      },
    });
    const reportB = await buildMarketingReport(prisma, checkedWithAds.id, checkedWithAds.domain);
    // Still UNAVAILABLE even when ads WERE found — matching is a source
    // capability gap, not a per-store result.
    expect(reportB.productMatching.status).toBe("UNAVAILABLE");
  });

  it("regions are extracted from real sourceMetadata when present", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 1, finishedAt: new Date() },
    });
    await prisma.adObservation.create({
      data: {
        storeId: store.id,
        platform: "GOOGLE",
        externalAdId: "CR001",
        status: "ACTIVE_EVIDENCE",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
        sourceMetadata: {
          lastShown: 1700000000,
          regions: [
            { regionName: "United States", firstShown: 20250101, lastShown: 20250601 },
            { regionName: "Mexico", firstShown: null, lastShown: 20250601 },
          ],
        },
      },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads.status).toBe("OBSERVED");
    if (report.ads.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.ads.value[0].regions).toEqual(["United States", "Mexico"]);
  });

  it("regions is null when sourceMetadata carries no region data — never a fabricated empty array vs. null distinction confusion", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 1, finishedAt: new Date() },
    });
    await prisma.adObservation.create({
      data: {
        storeId: store.id,
        platform: "GOOGLE",
        externalAdId: "CR001",
        status: "ACTIVE_EVIDENCE",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
        // sourceMetadata omitted — defaults to null, exactly the case being tested.
      },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.ads.status).toBe("OBSERVED");
    if (report.ads.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.ads.value[0].regions).toBeNull();
  });

  it("activity is null when the store has never been successfully checked", async () => {
    const store = await makeStore();
    const report = await buildMarketingReport(prisma, store.id, store.domain);
    expect(report.activity).toBeNull();
  });

  it("activity reflects hasEnoughHistory: false after only one successful collection", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 0, finishedAt: new Date() },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.activity).not.toBeNull();
    expect(report.activity?.hasEnoughHistory).toBe(false);
  });

  it("activity reflects hasEnoughHistory: true after a second successful collection", async () => {
    const store = await makeStore();
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 0, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 60_000) },
    });
    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 0, finishedAt: new Date() },
    });

    const report = await buildMarketingReport(prisma, store.id, store.domain);

    expect(report.activity?.hasEnoughHistory).toBe(true);
  });
});
