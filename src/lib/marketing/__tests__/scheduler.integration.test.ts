import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimDueStoresForMarketing, runMarketingSchedulerTick } from "../scheduler";
import type { AdSummary, DetailsResult, MarketingAdSource, SearchResult } from "../types";

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
const NOW = new Date("2026-08-11T12:00:00Z");

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Event","AdObservation","MarketingCollectionRun","Product","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore(overrides: Partial<{ tier: string; baselinedAt: Date | null; nextMarketingCollectionAt: Date }> = {}) {
  return prisma.store.create({
    data: {
      domain: `test-${randomUUID().slice(0, 8)}.com`,
      platform: "SHOPIFY",
      tier: (overrides.tier as never) ?? "WARM",
      baselinedAt: overrides.baselinedAt === undefined ? NOW : overrides.baselinedAt,
      ...(overrides.nextMarketingCollectionAt ? { nextMarketingCollectionAt: overrides.nextMarketingCollectionAt } : {}),
    },
  });
}

function fakeSource(outcome: SearchResult = { outcome: "SUCCESS", ads: [], requestCount: 1 }): MarketingAdSource {
  return {
    platform: "GOOGLE",
    source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
    async searchAdsForDomain(): Promise<SearchResult> {
      return outcome;
    },
    async getAdDetails(ad: AdSummary): Promise<DetailsResult> {
      return {
        outcome: "SUCCESS",
        requestCount: 1,
        details: {
          externalAdId: ad.externalAdId,
          destinationUrl: null,
          advertiserExternalId: ad.advertiserExternalId,
          advertiserName: ad.advertiserName,
          format: ad.format,
          sourceMetadata: null,
        },
      };
    },
  };
}

describe("claimDueStoresForMarketing", () => {
  it("claims a due, baselined, non-disabled store", async () => {
    const due = await makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });
    const claimed = await claimDueStoresForMarketing(prisma, NOW, 10);
    expect(claimed.map((s) => s.id)).toEqual([due.id]);
  });

  it("does not claim a store that isn't due yet", async () => {
    await makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() + 60_000) });
    const claimed = await claimDueStoresForMarketing(prisma, NOW, 10);
    expect(claimed).toHaveLength(0);
  });

  it("never claims a DISABLED store", async () => {
    await makeStore({ tier: "DISABLED", nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });
    const claimed = await claimDueStoresForMarketing(prisma, NOW, 10);
    expect(claimed).toHaveLength(0);
  });

  it("never claims a store that hasn't completed a Shopify baseline yet (no catalog to match against)", async () => {
    await makeStore({ baselinedAt: null, nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });
    const claimed = await claimDueStoresForMarketing(prisma, NOW, 10);
    expect(claimed).toHaveLength(0);
  });

  it("claiming pushes nextMarketingCollectionAt forward so an immediate second claim doesn't re-claim it", async () => {
    await makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });
    const first = await claimDueStoresForMarketing(prisma, NOW, 10);
    const second = await claimDueStoresForMarketing(prisma, NOW, 10);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("runMarketingSchedulerTick", () => {
  it("collects a claimed store and reschedules it per its tier's cadence on success", async () => {
    const store = await makeStore({ tier: "HOT", nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });

    const result = await runMarketingSchedulerTick({ prisma, source: fakeSource(), now: NOW, batchSize: 10 });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const updated = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    // HOT cadence is 1 day — well past the 10-minute claim-timeout window.
    expect(updated.nextMarketingCollectionAt.getTime()).toBeGreaterThan(NOW.getTime() + 20 * 60_000);
  });

  it("reschedules with the flat failure backoff when the vendor is unavailable", async () => {
    await makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });
    const failing = fakeSource({ outcome: "UNAVAILABLE", reason: "vendor down", requestCount: 1 });

    const result = await runMarketingSchedulerTick({ prisma, source: failing, now: NOW, batchSize: 10 });

    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ outcome: "unavailable", reason: "vendor down" });
  });

  it("one store's unexpected exception does not take down the rest of the batch", async () => {
    const bad = await makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() - 2000) });
    const good = await makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) });

    let calls = 0;
    const throwingSource: MarketingAdSource = {
      platform: "GOOGLE",
      source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
      async searchAdsForDomain(domain: string): Promise<SearchResult> {
        calls++;
        if (domain === bad.domain) throw new Error("boom");
        return { outcome: "SUCCESS", ads: [], requestCount: 1 };
      },
      async getAdDetails(): Promise<DetailsResult> {
        return { outcome: "UNAVAILABLE", reason: "unused", requestCount: 0 };
      },
    };

    const result = await runMarketingSchedulerTick({ prisma, source: throwingSource, now: NOW, batchSize: 10 });

    expect(result.claimed).toBe(2);
    expect(result.succeeded + result.failed).toBe(2);
    expect(calls).toBe(2); // both stores were attempted despite one throwing
    void good;
  });
});

describe("multiple concurrent scheduler workers — the real production shape (Sub-phase D)", () => {
  it("two ticks racing the SAME due-store pool never both collect the same store, and the vendor is never called twice for one store", async () => {
    const stores = await Promise.all(
      Array.from({ length: 6 }, () => makeStore({ nextMarketingCollectionAt: new Date(NOW.getTime() - 1000) })),
    );

    const callsPerDomain = new Map<string, number>();
    const countingSource: MarketingAdSource = {
      platform: "GOOGLE",
      source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
      async searchAdsForDomain(domain: string): Promise<SearchResult> {
        callsPerDomain.set(domain, (callsPerDomain.get(domain) ?? 0) + 1);
        return { outcome: "SUCCESS", ads: [], requestCount: 1 };
      },
      async getAdDetails(): Promise<DetailsResult> {
        return { outcome: "UNAVAILABLE", reason: "unused", requestCount: 0 };
      },
    };

    // Two genuinely concurrent "worker processes" racing the same claim
    // query, batch size covers the whole pool so both workers overlap on
    // the exact same candidate rows — this is what FOR UPDATE SKIP LOCKED
    // exists to make safe.
    const [tickA, tickB] = await Promise.all([
      runMarketingSchedulerTick({ prisma, source: countingSource, now: NOW, batchSize: 10 }),
      runMarketingSchedulerTick({ prisma, source: countingSource, now: NOW, batchSize: 10 }),
    ]);

    const totalClaimed = tickA.claimed + tickB.claimed;
    expect(totalClaimed).toBe(stores.length); // every store claimed exactly once, by exactly one worker

    // The real cost-control guarantee: no store's vendor endpoint was hit
    // more than once across BOTH workers combined.
    for (const store of stores) {
      expect(callsPerDomain.get(store.domain)).toBe(1);
    }

    // One MarketingCollectionRun per store for this cycle — not two.
    const runs = await prisma.marketingCollectionRun.groupBy({
      by: ["storeId"],
      _count: { id: true },
    });
    expect(runs.every((r) => r._count.id === 1)).toBe(true);
  });
});
