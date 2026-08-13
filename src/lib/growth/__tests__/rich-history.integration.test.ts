import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildGrowthReport, MAX_PRODUCT_HIGHLIGHTS } from "../report";
import { MAX_CATALOG_TREND_POINTS } from "../catalog";

/**
 * Milestone 7 Sub-phase D — richer-history validation.
 *
 * Every other growth-module test file exercises ONE module in isolation
 * (catalog.ts alone, bestseller.ts alone, persistence.ts alone) at a shallow
 * crawl depth (2-4 crawls), each already separately proving its own bound
 * holds against far-more-than-the-cap history. What's NOT yet covered
 * anywhere: a SINGLE realistic store, 20 real crawls deep, with multiple
 * products in different real lifecycle states at once, verified through the
 * actual composition entry point (buildGrowthReport) — proving the signals
 * stay mutually consistent (an established, always-present product must
 * never simultaneously read "insufficient history"; a newly-discovered
 * product must never fabricate a trend) once real depth and real churn are
 * both present together, not just individually.
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
    `TRUNCATE "Event","ProductStateSnapshot","StoreEntity","Product","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const START = new Date("2026-01-01T00:00:00Z");
/** Crawl N's finishedAt (1-indexed, weekly cadence — realistic COLD-tier spacing). */
const crawlDate = (n: number) => new Date(START.getTime() + (n - 1) * WEEK_MS);

async function makeStore() {
  return prisma.store.create({
    data: { domain: `rich-history-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY", baselinedAt: crawlDate(1) },
  });
}

async function makeCrawl(storeId: string, n: number) {
  const finishedAt = crawlDate(n);
  return prisma.crawl.create({
    data: { storeId, status: "OK", startedAt: new Date(finishedAt.getTime() - 1000), finishedAt },
  });
}

async function makeEvent(storeId: string, crawlId: string, entityKey: string, eventType: string, occurredAt: Date) {
  return prisma.event.create({
    data: {
      storeId,
      crawlId,
      entityType: "PRODUCT",
      entityKey,
      eventType: eventType as never,
      significance: 50,
      headline: "test",
      dedupeKey: randomUUID(),
      occurredAt,
    },
  });
}

describe("Rich-history validation — 20 real crawls, real Postgres, multiple products in different real states", () => {
  it("keeps catalog growth, bestseller, freshness, and persistence mutually consistent at real depth", async () => {
    const store = await makeStore();
    const TOTAL_CRAWLS = 20;
    const crawls = [];
    for (let n = 1; n <= TOTAL_CRAWLS; n++) {
      crawls.push(await makeCrawl(store.id, n));
    }

    // --- Product A ("Anchor"): present every one of the 20 crawls, rank
    // steadily improving #50 -> #5. Expect: ESTABLISHED freshness, 100%
    // persistence, IMPROVING momentum, a real (bounded) trajectory.
    const anchor = await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "anchor",
        handle: "anchor",
        title: "Anchor Product",
        priceMinCents: 2000,
        priceMaxCents: 2000,
        firstSeenAt: crawlDate(1),
        bestsellerRank: 4, // current rank, 0-indexed -> displayed #5
      },
    });
    for (let n = 1; n <= TOTAL_CRAWLS; n++) {
      const rank = 49 - Math.floor((n - 1) * (45 / (TOTAL_CRAWLS - 1))); // 49 down to ~4
      await prisma.productStateSnapshot.create({
        data: {
          productId: anchor.id,
          crawlId: crawls[n - 1].id,
          capturedAt: crawlDate(n),
          priceMinCents: 2000,
          priceMaxCents: 2000,
          variantCount: 1,
          availableVariants: 1,
          bestsellerRank: rank,
        },
      });
    }

    // --- Product B ("Newcomer"): first discovered at crawl 20 (the very
    // last one) — the STORE has 20 crawls of history, but this specific
    // product has only 1 qualifying crawl since its own discovery, below
    // MIN_CRAWLS_FOR_PERSISTENCE (3). Expect: freshness NEW (not
    // INSUFFICIENT_HISTORY — that's reserved for when the STORE itself
    // lacks history, which isn't the case here; and not ESTABLISHED —
    // confirmed by an earlier run of this exact test that firstSeenAt at
    // crawl 18 already has enough qualifying crawls, 18/19/20 = 3, to read
    // ESTABLISHED instead, which is itself the real MIN_CRAWLS_FOR_PERSISTENCE
    // boundary working correctly, not a bug).
    const newcomer = await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "newcomer",
        handle: "newcomer",
        title: "Newcomer Product",
        priceMinCents: 1500,
        priceMaxCents: 1500,
        firstSeenAt: crawlDate(20),
        bestsellerRank: null,
      },
    });

    // --- Product C ("Flapper"): active crawls 1-10, missing (confirmed
    // REMOVED) at crawl 11, restored at crawl 15, active through crawl 20.
    // Expect: a real, imperfect (not 100%, not INSUFFICIENT_HISTORY)
    // persistence ratio, and one real PRODUCT_RESTORED event counted.
    const flapper = await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "flapper",
        handle: "flapper",
        title: "Flapper Product",
        priceMinCents: 1000,
        priceMaxCents: 1000,
        firstSeenAt: crawlDate(1),
        missingSince: null,
        status: "ACTIVE",
        bestsellerRank: null,
      },
    });
    await makeEvent(store.id, crawls[10].id, "flapper", "PRODUCT_REMOVED", crawlDate(11));
    await makeEvent(store.id, crawls[14].id, "flapper", "PRODUCT_RESTORED", crawlDate(15));

    const report = await buildGrowthReport(prisma, store.id, store.domain);

    // --- Catalog growth: real depth, correctly bounded sampling.
    expect(report.catalogGrowth.trend.status).toBe("OBSERVED");
    if (report.catalogGrowth.trend.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.catalogGrowth.trend.sampledFromCrawlCount).toBe(TOTAL_CRAWLS);
    // 20 real crawls, capped down to MAX_CATALOG_TREND_POINTS — never one
    // point per crawl once real history exceeds the cap.
    expect(report.catalogGrowth.trend.points.length).toBe(MAX_CATALOG_TREND_POINTS);
    expect(report.catalogGrowth.hasEnoughHistory).toBe(true);

    // --- Product highlights: bounded regardless of how many real products exist.
    expect(report.productHighlights.length).toBeLessThanOrEqual(MAX_PRODUCT_HIGHLIGHTS);

    const anchorHighlight = report.productHighlights.find((h) => h.handle === "anchor");
    const newcomerHighlight = report.productHighlights.find((h) => h.handle === "newcomer");
    const flapperHighlight = report.productHighlights.find((h) => h.handle === "flapper");
    expect(anchorHighlight).toBeDefined();
    expect(newcomerHighlight).toBeDefined();
    // flapper has no bestsellerRank and isn't among the most-recently-discovered
    // (firstSeenAt crawl 1, same as anchor) — MAX_PRODUCT_HIGHLIGHTS=20 easily
    // fits all 3 real products here, so it should still be present.
    expect(flapperHighlight).toBeDefined();

    // --- Anchor: real, consistent, non-contradictory signals.
    expect(anchorHighlight!.freshness.label).toBe("ESTABLISHED");
    expect(anchorHighlight!.freshness.persistence.status).toBe("OBSERVED");
    if (anchorHighlight!.freshness.persistence.status === "OBSERVED") {
      expect(anchorHighlight!.freshness.persistence.ratio).toBe(1); // present every real crawl
    }
    expect(anchorHighlight!.bestseller.momentum).toBe("IMPROVING");
    expect(anchorHighlight!.bestseller.currentRank).toBe(4);
    // Rank number IMPROVED (49 -> 4) — never described as sales/revenue anywhere in the raw signal.
    expect(JSON.stringify(anchorHighlight!.bestseller)).not.toMatch(/sales|revenue/i);

    // --- Newcomer: honest NEW state, no fabricated trend from a product
    // that genuinely has almost no history of its own yet.
    expect(newcomerHighlight!.freshness.label).toBe("NEW");
    expect(newcomerHighlight!.bestseller.currentRank).toBeNull();
    expect(newcomerHighlight!.bestseller.trajectory).toEqual([]);

    // --- Flapper: a real, imperfect persistence ratio — evidence of the
    // actual gap, not silently smoothed over, and not misreported as
    // "recently missing" now that it's back and ACTIVE.
    expect(flapperHighlight!.freshness.label).toBe("ESTABLISHED");
    expect(flapperHighlight!.freshness.persistence.status).toBe("OBSERVED");
    if (flapperHighlight!.freshness.persistence.status === "OBSERVED") {
      expect(flapperHighlight!.freshness.persistence.ratio).toBeLessThan(1);
      expect(flapperHighlight!.freshness.persistence.ratio).toBeGreaterThan(0);
    }
  });
});
