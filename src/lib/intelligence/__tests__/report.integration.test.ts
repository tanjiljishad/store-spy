import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildStoreIntelligenceReport } from "../report";

/**
 * The canonical composer's job is composition, not calculation — these
 * tests exist to prove the SECTION MAPPING is correct (the right upstream
 * field lands in the right canonical section, nothing dropped, nothing
 * duplicated), not to re-prove growth/marketing/persistence math already
 * covered by their own dedicated integration suites.
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

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AnalysisUsage","Event","ProductStateSnapshot","AdObservation","MarketingCollectionRun","Product","StoreEntity","Crawl","StoreStats","Watchlist","User","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStoreAndUser(domain: string, overrides: Partial<{ baselinedAt: Date }> = {}) {
  const store = await prisma.store.create({
    data: { domain, platform: "SHOPIFY", themeName: "Dawn", baselinedAt: overrides.baselinedAt ?? new Date() },
  });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
  await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
  return { store, user };
}

async function makeCrawl(storeId: string, finishedAt: Date) {
  return prisma.crawl.create({
    data: { storeId, status: "OK", startedAt: new Date(finishedAt.getTime() - 1000), finishedAt },
  });
}

const D = (s: string) => new Date(s);

describe("buildStoreIntelligenceReport — section composition", () => {
  it("composes every section from real, independently-seeded data, correctly attributed", async () => {
    const { store, user } = await makeStoreAndUser("rich-store.com", { baselinedAt: D("2026-01-01") });

    for (const d of [D("2026-01-01"), D("2026-02-01"), D("2026-03-01")]) await makeCrawl(store.id, d);

    await prisma.storeEntity.createMany({
      data: [
        { storeId: store.id, kind: "APP", key: "klaviyo", status: "ACTIVE" },
        { storeId: store.id, kind: "APP", key: "judgeme", status: "ACTIVE" },
        { storeId: store.id, kind: "PIXEL", key: "facebook", status: "ACTIVE" },
        { storeId: store.id, kind: "PAYMENT_PROVIDER", key: "shop_pay", status: "ACTIVE" },
      ],
    });

    await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "p1",
        handle: "widget",
        title: "Widget",
        priceMinCents: 1000,
        priceMaxCents: 1000,
        firstSeenAt: D("2026-01-01"),
        bestsellerRank: 4,
      },
    });

    await prisma.marketingCollectionRun.create({
      data: { storeId: store.id, platform: "GOOGLE", outcome: "SUCCESS", adsObserved: 1, finishedAt: D("2026-03-01") },
    });
    await prisma.adObservation.create({
      data: {
        storeId: store.id,
        platform: "GOOGLE",
        externalAdId: "CR1",
        status: "ACTIVE_EVIDENCE",
        firstSeenAt: D("2026-03-01"),
        lastSeenAt: D("2026-03-01"),
        source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
      },
    });

    const report = await buildStoreIntelligenceReport(prisma, store.id, store.domain, user.id, true);

    // identity / technology
    expect(report.identity.domain).toBe("rich-store.com");
    expect(report.identity.theme).toEqual({ status: "OBSERVED", value: { name: "Dawn", version: null } });
    expect(report.technology.apps.status).toBe("OBSERVED");
    if (report.technology.apps.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.technology.apps.value.sort()).toEqual(["judgeme", "klaviyo"]);
    expect(report.technology.pixels).toEqual({ status: "OBSERVED", value: ["facebook"] });
    expect(report.technology.paymentProviders).toEqual({ status: "OBSERVED", value: ["shop_pay"] });

    // catalog
    expect(report.catalog.productCount).toEqual({ status: "OBSERVED", value: 1 });
    expect(report.catalog.averagePrice).toEqual({ status: "OBSERVED", value: 1000 });

    // growth (store-level) — real 3-crawl history clears every threshold
    expect(report.growth.hasEnoughHistory).toBe(true);
    expect(report.growth.currentProductCount).toBe(1);

    // productIntelligence — the one ranked product is highlighted
    expect(report.productIntelligence.highlights).toHaveLength(1);
    expect(report.productIntelligence.highlights[0].bestseller.currentRank).toBe(4);

    // marketing — real ad, real activity
    expect(report.marketing.ads.status).toBe("OBSERVED");
    if (report.marketing.ads.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.marketing.ads.value).toHaveLength(1);

    // reviews — judgeme detected as infrastructure, velocity still permanently unavailable
    expect(report.reviews.infrastructure.status).toBe("OBSERVED");
    if (report.reviews.infrastructure.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.reviews.infrastructure.value.map((e) => e.key)).toEqual(["judgeme"]);
    expect(report.reviews.velocity.status).toBe("UNAVAILABLE");

    // commercial — permanently unavailable, never fabricated
    expect(report.commercial.revenue.status).toBe("UNAVAILABLE");
    expect(report.commercial.traffic.status).toBe("UNAVAILABLE");

    // monitoring / entitlement passthrough
    expect(report.monitoring.totalCrawls).toBe(3);
    // Milestone 12 §1.1/§1.2: FREE's real windowed limit is 10/24h.
    expect(report.entitlement.analysesUsed).toBe(1);
    expect(report.entitlement.analysesLimit).toBe(10);
    expect(report.entitlement.alreadyAnalyzed).toBe(true);
    expect(typeof report.entitlement.resetsAt).toBe("string");

    // meta — real history-sufficiency flags, no fabricated composite score anywhere.
    // (Deliberately NOT matching the bare word "confidence" here: matchConfidence
    // is a legitimate, pre-existing Milestone 4 field — deterministic exact-URL-match
    // confidence, not a fabricated score — and IntelligenceField's own ESTIMATED/
    // INFERRED confidence mechanism is an approved part of the epistemic-status
    // system, not something this assertion is meant to forbid.)
    expect(report.meta.historySufficiency.growth).toBe(true);
    expect(report.meta.historySufficiency.marketing).toBe(false); // only one collection run ever succeeded
    expect(JSON.stringify(report)).not.toMatch(/opportunityScore|storeScore|growthScore|competitorScore/i);
  });

  it("is honest about insufficient history — never a fake trend from one crawl", async () => {
    const { store, user } = await makeStoreAndUser("single-crawl.com");
    await makeCrawl(store.id, new Date());

    const report = await buildStoreIntelligenceReport(prisma, store.id, store.domain, user.id, true);

    expect(report.growth.hasEnoughHistory).toBe(false);
    expect(report.growth.trend.status).toBe("INSUFFICIENT_HISTORY");
    expect(report.growth.signals).toEqual([]);
    expect(report.meta.historySufficiency.growth).toBe(false);
    expect(report.marketing.ads.status).toBe("UNAVAILABLE"); // never checked, not "0 ads"
  });

  it("is deterministic: identical DB state produces an identical report (ignoring generation timestamps)", async () => {
    const { store, user } = await makeStoreAndUser("deterministic.com");
    await makeCrawl(store.id, D("2026-01-01"));
    await makeCrawl(store.id, D("2026-02-01"));
    await makeCrawl(store.id, D("2026-03-01"));
    await prisma.product.create({
      data: { storeId: store.id, externalId: "p1", handle: "p1", title: "P1", priceMinCents: 500, priceMaxCents: 500, firstSeenAt: D("2026-01-01") },
    });

    const a = await buildStoreIntelligenceReport(prisma, store.id, store.domain, user.id, true);
    const b = await buildStoreIntelligenceReport(prisma, store.id, store.domain, user.id, true);

    const strip = (r: typeof a) => ({ ...r, meta: { ...r.meta, generatedAt: null }, marketing: { ...r.marketing, lastCheckedAt: r.marketing.lastCheckedAt } });
    expect(strip(a)).toEqual(strip(b));
  });
});
