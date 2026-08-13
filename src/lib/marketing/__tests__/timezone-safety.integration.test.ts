import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runMarketingCollection } from "../persist";
import { claimDueStoresForMarketing } from "../scheduler";
import type { AdSummary, DetailsResult, MarketingAdSource, SearchResult } from "../types";

/**
 * Marketing-pipeline counterpart to
 * monitoring/__tests__/timezone-safety.integration.test.ts — same
 * pathological-timezone regression guard, applied to the raw-SQL
 * AdObservation upsert (persist.ts) and the nextMarketingCollectionAt claim
 * query (scheduler.ts), both of which independently reimplement the
 * AT TIME ZONE 'UTC' cast rather than inheriting it from the Shopify
 * pipeline. See the "Database time rule" in AGENTS.md.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
}
if (!/test/i.test(url)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`,
  );
}

const separator = url.includes("?") ? "&" : "?";
const prisma = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });

const PATHOLOGICAL_TZ = "Asia/Kathmandu"; // UTC+5:45
const NOW = new Date("2026-08-11T12:00:00Z");

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Event","AdObservation","MarketingCollectionRun","Product","Store" RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe(`SET TIME ZONE '${PATHOLOGICAL_TZ}'`);
});

function fakeSource(ads: AdSummary[]): MarketingAdSource {
  return {
    platform: "GOOGLE",
    source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
    async searchAdsForDomain(): Promise<SearchResult> {
      return { outcome: "SUCCESS", ads, requestCount: 1 };
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

describe(`marketing pipeline stays correct under a non-UTC session timezone (${PATHOLOGICAL_TZ})`, () => {
  it("AdObservation.firstSeenAt / lastSeenAt match the collection's `now` exactly (persist.ts raw-SQL upsert)", async () => {
    const store = await prisma.store.create({
      data: { domain: "tz-marketing.com", platform: "SHOPIFY", tier: "WARM", baselinedAt: NOW },
    });
    const source = fakeSource([{ externalAdId: "CR001", advertiserExternalId: "AR001", advertiserName: "Acme", format: "text" }]);

    await runMarketingCollection({ prisma, storeId: store.id, source, now: NOW });

    const observation = await prisma.adObservation.findFirstOrThrow({ where: { storeId: store.id } });
    expect(observation.firstSeenAt.getTime()).toBe(NOW.getTime());
    expect(observation.lastSeenAt.getTime()).toBe(NOW.getTime());
  });

  it("claimDueStoresForMarketing respects the due/not-due boundary", async () => {
    const due = await prisma.store.create({
      data: {
        domain: "tz-marketing-due.com",
        platform: "SHOPIFY",
        tier: "WARM",
        baselinedAt: NOW,
        nextMarketingCollectionAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.store.create({
      data: {
        domain: "tz-marketing-not-due.com",
        platform: "SHOPIFY",
        tier: "WARM",
        baselinedAt: NOW,
        nextMarketingCollectionAt: new Date(Date.now() + 60_000),
      },
    });

    const claimed = await claimDueStoresForMarketing(prisma, new Date(), 10);

    expect(claimed.map((s) => s.id)).toEqual([due.id]);
  });

  it("claiming pushes nextMarketingCollectionAt far enough forward that an immediate second claim doesn't re-claim it", async () => {
    // Explicit backdated nextMarketingCollectionAt, not the bare
    // @default(now()) — matching the sibling "due/not-due boundary" test
    // above. See the identical fix/rationale in
    // monitoring/__tests__/timezone-safety.integration.test.ts.
    await prisma.store.create({
      data: {
        domain: "tz-marketing-claimed-once.com",
        platform: "SHOPIFY",
        tier: "WARM",
        baselinedAt: NOW,
        nextMarketingCollectionAt: new Date(Date.now() - 1000),
      },
    });

    const first = await claimDueStoresForMarketing(prisma, new Date(), 10);
    const second = await claimDueStoresForMarketing(prisma, new Date(), 10);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
