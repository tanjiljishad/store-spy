import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedStoreSnapshot } from "../../crawl/types";
import { runDiffAndPersist } from "../persist";

/**
 * These three invariants can ONLY fail against a real Postgres, and all three
 * fail silently: no exception, just wrong data that surfaces weeks later as
 * "why did this store's chart flatline".
 *
 * Run via `npm run test:integration` — it loads .env.test through dotenv-cli,
 * so DATABASE_URL is never inherited from the shell or from .env. Do not add
 * a fallback here: this suite TRUNCATEs every table in beforeEach, and a
 * fallback to a real DATABASE_URL is how that stops being a test database.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
}
if (!/test/i.test(url)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}). ` +
      `This suite TRUNCATEs every table.`,
  );
}

const prisma = new PrismaClient();

const NOW = new Date("2026-08-08T12:00:00Z");

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  // TRUNCATE ... CASCADE is far faster than deleteMany and resets identity.
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore(baselined: boolean) {
  return prisma.store.create({
    data: {
      domain: `test-${randomUUID().slice(0, 8)}.com`,
      platform: "SHOPIFY",
      currency: "USD",
      baselinedAt: baselined ? new Date("2026-01-01T00:00:00Z") : null,
    },
  });
}

function snapshot(
  products: Array<{ id: string; price: number; available?: number; rank?: number | null }>,
  overrides: Partial<NormalizedStoreSnapshot> = {},
): NormalizedStoreSnapshot {
  return {
    domain: "test.com",
    currency: "USD",
    products: products.map((p) => ({
      externalId: p.id,
      handle: `h-${p.id}`,
      title: `Product ${p.id}`,
      vendor: "Acme",
      productType: "Gadget",
      tags: ["a", "b"],
      sourceCreatedAt: new Date("2026-06-01T00:00:00Z"),
      publishedAt: new Date("2026-06-01T00:00:00Z"),
      priceMinCents: p.price,
      priceMaxCents: p.price,
      compareAtMaxCents: null,
      variantCount: 3,
      availableVariants: p.available ?? 3,
      variants: [],
      bestsellerRank: p.rank ?? null,
      imageHash: null,
    })),
    collectionHandles: ["all"],
    hasCollectionData: true,
    tech: null,
    hasTechData: false,
    partial: false,
    pagesExpected: 1,
    pagesFetched: 1,
    httpErrors: 0,
    hasRankData: true,
    capturedAt: NOW,
    ...overrides,
  };
}

async function crawl(storeId: string) {
  const c = await prisma.crawl.create({ data: { storeId, status: "RUNNING" } });
  return c.id;
}

// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("replaying the same crawl writes no additional events", async () => {
    const store = await makeStore(true);
    await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "p1",
        handle: "h",
        title: "Widget",
        priceMinCents: 7900,
        priceMaxCents: 7900,
        variantCount: 3,
        availableVariants: 3,
      },
    });

    const snap = snapshot([{ id: "p1", price: 5900 }]);

    const first = await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id), snapshot: snap, now: NOW,
    });
    expect(first.eventsWritten).toBeGreaterThan(0);

    const second = await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id), snapshot: snap, now: NOW,
    });

    // Second run short-circuits on the hash; even if it didn't, dedupeKey blocks it.
    const total = await prisma.event.count({ where: { storeId: store.id } });
    expect(total).toBe(first.eventsWritten);
    expect(second.eventsWritten).toBe(0);
  });
});

describe("short-circuit", () => {
  it("an unchanged crawl writes one Crawl row and zero snapshots", async () => {
    const store = await makeStore(false);

    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900 }]), now: NOW,
    });

    const snapsAfterBaseline = await prisma.productStateSnapshot.count();

    const second = await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900 }]), now: NOW,
    });

    expect(second.shortCircuited).toBe(true);
    // THE assertion protecting the entire storage model.
    expect(await prisma.productStateSnapshot.count()).toBe(snapsAfterBaseline);

    const store2 = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(store2.unchangedStreak).toBe(1);
  });

  it("rank churn alone does NOT short-circuit", async () => {
    const store = await makeStore(false);
    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900, rank: 5 }, { id: "p2", price: 4900, rank: 1 }]),
      now: NOW,
    });

    const r = await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900, rank: 1 }, { id: "p2", price: 4900, rank: 5 }]),
      now: NOW,
    });
    expect(r.shortCircuited).toBe(false);
  });
});

describe("bulk upsert SQL", () => {
  it("round-trips tags as text[] and preserves product ids across crawls", async () => {
    const store = await makeStore(false);
    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900 }]), now: NOW,
    });

    const before = await prisma.product.findFirstOrThrow({ where: { storeId: store.id } });
    expect(before.tags).toEqual(["a", "b"]);

    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 5900 }]), now: NOW,
    });

    const after = await prisma.product.findFirstOrThrow({ where: { storeId: store.id } });
    // A changed id here would orphan every historical snapshot row.
    expect(after.id).toBe(before.id);
    expect(after.priceMinCents).toBe(5900);
    expect(after.firstSeenAt.toISOString()).toBe(before.firstSeenAt.toISOString());
  });

  it("freezes lastSeenAt when a product goes MISSING", async () => {
    const store = await makeStore(false);
    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900 }, { id: "p2", price: 4900 }]), now: NOW,
    });

    const seenAt = (await prisma.product.findFirstOrThrow({
      where: { storeId: store.id, externalId: "p1" },
    })).lastSeenAt;

    const later = new Date("2026-08-09T12:00:00Z");
    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p2", price: 4900 }]), now: later,
    });

    const gone = await prisma.product.findFirstOrThrow({
      where: { storeId: store.id, externalId: "p1" },
    });
    expect(gone.status).toBe("MISSING");
    // lastSeenAt must record the TRUE last sighting, not the crawl that noticed
    // the absence. Every removal analytic depends on this being right.
    expect(gone.lastSeenAt.toISOString()).toBe(seenAt.toISOString());
  });
});

describe("store entities", () => {
  const TECH = {
    themeName: "Dawn",
    themeVersion: null,
    apps: ["klaviyo"],
    pixels: { facebook: "111" },
    paymentProviders: ["shop_pay"],
    emailPlatform: null,
  };
  const MANY_COLLECTIONS = Array.from({ length: 200 }, (_, i) => `collection-${i}`);

  it("the allbirds case, live: 200 unchanged collections + unchanged tech across two real crawls produces zero entity events", async () => {
    const store = await makeStore(false);

    const first = await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900 }], {
        collectionHandles: MANY_COLLECTIONS,
        tech: TECH,
        hasTechData: true,
      }),
      now: NOW,
    });
    expect(first.result?.isBaseline).toBe(true);
    expect(await prisma.storeEntity.count({ where: { storeId: store.id } })).toBe(
      MANY_COLLECTIONS.length + 1 /* klaviyo */ + 1 /* facebook pixel */ + 1 /* shop_pay */,
    );

    // Force past the short-circuit (a price move) while leaving every
    // collection and every tech signature identical — this is exactly the
    // allbirds scenario: nothing about the store's apps/pixels/collections
    // actually changed between crawls.
    const later = new Date("2026-08-09T12:00:00Z");
    const second = await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 5900 }], {
        collectionHandles: MANY_COLLECTIONS,
        tech: TECH,
        hasTechData: true,
      }),
      now: later,
    });

    expect(second.shortCircuited).toBe(false); // the price move forced a real diff
    const entityEvents = await prisma.event.findMany({
      where: { storeId: store.id, entityType: { in: ["COLLECTION", "TECH"] } },
    });
    expect(entityEvents).toHaveLength(0);
  });

  it("persists the MISSING state machine for entities, not immediate removal", async () => {
    const store = await makeStore(false);

    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      snapshot: snapshot([{ id: "p1", price: 7900 }], { tech: TECH, hasTechData: true }),
      now: NOW,
    });

    const later = new Date("2026-08-09T12:00:00Z");
    await runDiffAndPersist({
      prisma, storeId: store.id, crawlId: await crawl(store.id),
      // klaviyo script didn't load this crawl — a single-fetch flap, not a
      // real removal (price still moves, so this isn't a short-circuit).
      snapshot: snapshot([{ id: "p1", price: 5900 }], {
        tech: { ...TECH, apps: [] },
        hasTechData: true,
      }),
      now: later,
    });

    const klaviyo = await prisma.storeEntity.findFirstOrThrow({
      where: { storeId: store.id, kind: "APP", key: "klaviyo" },
    });
    expect(klaviyo.status).toBe("MISSING");
    expect(klaviyo.missingStreak).toBe(1);

    const appEvents = await prisma.event.findMany({
      where: { storeId: store.id, eventType: { in: ["APP_ADDED", "APP_REMOVED"] } },
    });
    // Not confirmed yet (removalConfirmations defaults to 2) — no alert fired.
    expect(appEvents).toHaveLength(0);
  });
});

describe("concurrency", () => {
  it("two workers crawling the same store do not create duplicate products", async () => {
    const store = await makeStore(false);
    const snap = snapshot([{ id: "p1", price: 7900 }, { id: "p2", price: 4900 }]);

    const results = await Promise.allSettled([
      runDiffAndPersist({ prisma, storeId: store.id, crawlId: await crawl(store.id), snapshot: snap, now: NOW }),
      runDiffAndPersist({ prisma, storeId: store.id, crawlId: await crawl(store.id), snapshot: snap, now: NOW }),
    ]);

    // One may legitimately fail on a serialization conflict — that is fine and
    // the scheduler should retry. What must NOT happen is duplicate rows.
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    expect(succeeded).toBeGreaterThanOrEqual(1);
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(2);

    const keys = await prisma.event.findMany({
      where: { storeId: store.id }, select: { dedupeKey: true },
    });
    expect(new Set(keys.map((k) => k.dedupeKey)).size).toBe(keys.length);
  });
});
