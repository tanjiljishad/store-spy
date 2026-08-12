import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getProductPersistence, PERSISTENCE_WINDOW_CRAWLS } from "../persistence";
import { runScheduledCrawl } from "../../monitoring/run-scheduled-crawl";

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
  return prisma.store.create({ data: { domain: `persist-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
// finishedAt is what persistence.ts actually reads (see its module doc:
// missingSince/event occurredAt share finishedAt's "now", never startedAt's
// earlier one) — startedAt is set a beat earlier here specifically so a
// regression that reverts to comparing startedAt would fail these tests.
async function makeCrawl(storeId: string, finishedAt: Date, status: "OK" | "PARTIAL" = "OK") {
  return prisma.crawl.create({
    data: { storeId, status, startedAt: new Date(finishedAt.getTime() - 1000), finishedAt },
  });
}
async function makeProduct(
  storeId: string,
  overrides: Partial<{ externalId: string; firstSeenAt: Date; missingSince: Date | null; status: "ACTIVE" | "MISSING" | "REMOVED" }> = {},
) {
  return prisma.product.create({
    data: {
      storeId,
      externalId: overrides.externalId ?? "p1",
      handle: "widget",
      title: "Widget",
      priceMinCents: 1000,
      priceMaxCents: 1000,
      firstSeenAt: overrides.firstSeenAt ?? new Date("2026-01-01"),
      missingSince: overrides.missingSince ?? null,
      status: overrides.status ?? "ACTIVE",
    },
  });
}
async function makeLifecycleEvent(
  storeId: string,
  externalId: string,
  eventType: "PRODUCT_REMOVED" | "PRODUCT_RESTORED",
  occurredAt: Date,
) {
  return prisma.event.create({
    data: {
      storeId,
      entityType: "PRODUCT",
      entityKey: externalId,
      eventType,
      significance: 50,
      headline: "test",
      dedupeKey: randomUUID(),
      occurredAt,
    },
  });
}

const NOW = new Date("2026-08-11T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000);

// Minimal real-crawler fetch mocks, same shape as
// monitoring/__tests__/timezone-safety.integration.test.ts, reused here for
// the one end-to-end regression test that needs to run the actual
// crawl -> diff -> persist pipeline rather than hand-constructed rows.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}
function shopifyProduct(id: number) {
  return {
    id,
    handle: `p-${id}`,
    title: `Product ${id}`,
    vendor: "Acme",
    product_type: "Gadget",
    tags: "",
    created_at: "2026-01-01T00:00:00Z",
    published_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    variants: [{ id: id * 10, title: "Default", sku: null, price: "19.00", compare_at_price: null, available: true, position: 1 }],
  };
}
function routesForProducts(products: unknown[]) {
  const routes: Record<string, () => Response> = {
    "/products.json": () => jsonResponse({ products }),
    "/collections/all/products.json": () => jsonResponse({ products: [] }),
    "/collections.json": () => jsonResponse({ collections: [] }),
    "/": () => textResponse("<html></html>"),
  };
  return (async (input: string | URL) => {
    const u = new URL(String(input));
    return routes[u.pathname]?.() ?? textResponse("not found", 404);
  }) as unknown as typeof fetch;
}

describe("getProductPersistence — real Postgres", () => {
  it("a stable product across real crawls is 100% persistent, with zero ProductStateSnapshot rows written", async () => {
    const store = await makeStore();
    for (const h of [96, 72, 48, 24, 0]) await makeCrawl(store.id, hoursAgo(h));
    const product = await makeProduct(store.id, { firstSeenAt: new Date("2026-01-01") });

    const snapshotCount = await prisma.productStateSnapshot.count({ where: { productId: product.id } });
    expect(snapshotCount).toBe(0); // confirms the test setup matches the real-world "stable, no history rows" case

    const result = await getProductPersistence(prisma, store.id, product);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.ratio).toBe(1);
    expect(result.windowCrawlCount).toBe(5);
  });

  it("excludes the ongoing gap using real Product.missingSince, before any PRODUCT_REMOVED event exists", async () => {
    const store = await makeStore();
    const crawlTimes = [96, 72, 48, 24, 0].map(hoursAgo);
    for (const t of crawlTimes) await makeCrawl(store.id, t);
    const product = await makeProduct(store.id, {
      firstSeenAt: new Date("2026-01-01"),
      status: "MISSING",
      missingSince: hoursAgo(0), // went missing on the most recent crawl, streak 1, no event yet
    });

    const eventCount = await prisma.event.count({ where: { storeId: store.id, entityKey: product.externalId } });
    expect(eventCount).toBe(0);

    const result = await getProductPersistence(prisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.observedActiveCount).toBe(4);
    expect(result.ratio).toBe(0.8);
  });

  it("uses real PRODUCT_REMOVED/PRODUCT_RESTORED events (via the new Event index) to exclude a resolved past gap", async () => {
    const store = await makeStore();
    const crawlTimes = [120, 96, 72, 48, 24, 0].map(hoursAgo);
    for (const t of crawlTimes) await makeCrawl(store.id, t);
    const product = await makeProduct(store.id, { firstSeenAt: new Date("2026-01-01"), status: "ACTIVE", missingSince: null });

    await makeLifecycleEvent(store.id, product.externalId, "PRODUCT_REMOVED", hoursAgo(96));
    await makeLifecycleEvent(store.id, product.externalId, "PRODUCT_RESTORED", hoursAgo(48));

    const result = await getProductPersistence(prisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    // oldest(120h) active, 96h/72h excluded (removed window), 48h/24h/0h active again
    expect(result.windowCrawlCount).toBe(6);
    expect(result.observedActiveCount).toBe(4);
  });

  it("returns INSUFFICIENT_HISTORY and distinguishes a new product from a young store using real data", async () => {
    const store = await makeStore();
    for (const h of [96, 72, 48, 24, 0]) await makeCrawl(store.id, hoursAgo(h));
    const brandNewProduct = await makeProduct(store.id, { externalId: "new1", firstSeenAt: hoursAgo(0) });

    const result = await getProductPersistence(prisma, store.id, brandNewProduct);
    expect(result.status).toBe("INSUFFICIENT_HISTORY");
    if (result.status !== "INSUFFICIENT_HISTORY") throw new Error("unreachable");
    expect(result.realCrawlsAvailable).toBe(1);
    expect(result.storeRealCrawlCount).toBe(5); // the store itself has plenty of history
  });

  it("bounds the window at PERSISTENCE_WINDOW_CRAWLS even when far more real crawls exist", async () => {
    const store = await makeStore();
    const totalCrawls = PERSISTENCE_WINDOW_CRAWLS + 15;
    for (let i = totalCrawls; i >= 0; i--) await makeCrawl(store.id, hoursAgo(i));
    const product = await makeProduct(store.id, { firstSeenAt: new Date("2020-01-01") }); // long-lived, predates every crawl

    const result = await getProductPersistence(prisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.windowCrawlCount).toBe(PERSISTENCE_WINDOW_CRAWLS);
  });

  it("a failed crawl (status FAILED) never counts as a real observation", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, hoursAgo(96));
    await makeCrawl(store.id, hoursAgo(72));
    await makeCrawl(store.id, hoursAgo(48));
    await prisma.crawl.create({ data: { storeId: store.id, status: "FAILED", startedAt: hoursAgo(24) } });
    const product = await makeProduct(store.id, { firstSeenAt: new Date("2026-01-01") });

    const result = await getProductPersistence(prisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.windowCrawlCount).toBe(3); // the FAILED crawl is excluded entirely
  });
});

describe("getProductPersistence — the exact discovering crawl lands on the correct side (regression)", () => {
  it("a crawl's own finishedAt, not its earlier startedAt, is what excludes it from the active count", async () => {
    // Reproduces the real production shape: startedAt is set at crawl-row
    // creation (before the fetch), finishedAt/missingSince share a LATER
    // "now" captured at persist time. A version of this module that compared
    // against startedAt would count crawl 3 below as ACTIVE (since
    // startedAt(crawl3) < missingSince), when crawl 3 is literally the crawl
    // that discovered the product missing.
    const store = await makeStore();
    const crawl1Finish = hoursAgo(72);
    const crawl2Finish = hoursAgo(48);
    const crawl3Finish = hoursAgo(24); // the crawl that discovers the product missing
    const crawl4Finish = hoursAgo(0);

    await makeCrawl(store.id, crawl1Finish);
    await makeCrawl(store.id, crawl2Finish);
    await makeCrawl(store.id, crawl3Finish);
    await makeCrawl(store.id, crawl4Finish);

    // missingSince == crawl3's finishedAt exactly (the real invariant — see
    // diff/persist.ts), while crawl3's startedAt is a full second earlier.
    const product = await makeProduct(store.id, {
      firstSeenAt: new Date("2026-01-01"),
      status: "MISSING",
      missingSince: crawl3Finish,
    });

    const result = await getProductPersistence(prisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    // crawl1, crawl2 active; crawl3 (the discovering crawl) and crawl4 excluded.
    expect(result.observedActiveCount).toBe(2);
    expect(result.windowCrawlCount).toBe(4);
  });

  it("end to end through the real scheduled-crawl pipeline: a product missing on the second real crawl is excluded from that exact crawl", async () => {
    const store = await prisma.store.create({
      data: { domain: `persist-e2e-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY", tier: "WARM" },
    });
    const SAFE_DNS = async () => [{ address: "8.8.8.8" }];

    // P2 stays present throughout — the crawler treats a zero-product
    // response as a crawl FAILURE (see run-scheduled-crawl.ts), so P1's
    // disappearance must be tested against a catalog that isn't also empty.
    // First real crawl: both P1 and P2 present. now is pinned safely ahead
    // of wall-clock so finishedAt is unambiguously later than the
    // DB-generated startedAt of this same row, exactly like real production
    // timing.
    await runScheduledCrawl({
      prisma,
      store,
      now: new Date(Date.now() + 60_000),
      fetchImpl: routesForProducts([shopifyProduct(1), shopifyProduct(2)]),
      dnsLookup: SAFE_DNS,
    });

    // Second real crawl: P1 is gone, P2 remains. This crawl's own finishedAt
    // is what should exclude P1 — not its startedAt (earlier, at row creation).
    await runScheduledCrawl({
      prisma,
      store,
      now: new Date(Date.now() + 120_000),
      fetchImpl: routesForProducts([shopifyProduct(2)]),
      dnsLookup: SAFE_DNS,
    });

    // A third crawl just to clear MIN_CRAWLS_FOR_PERSISTENCE.
    await runScheduledCrawl({
      prisma,
      store,
      now: new Date(Date.now() + 180_000),
      fetchImpl: routesForProducts([shopifyProduct(2)]),
      dnsLookup: SAFE_DNS,
    });

    const product = await prisma.product.findFirstOrThrow({ where: { storeId: store.id, externalId: "1" } });
    expect(product.status).not.toBe("ACTIVE");

    const result = await getProductPersistence(prisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    // Only the first crawl (P1 present) counts as active; the crawl that
    // discovered it missing, and every crawl after, are excluded.
    expect(result.observedActiveCount).toBe(1);
    expect(result.windowCrawlCount).toBe(3);
  });
});

describe("getProductPersistence — stays correct under a non-UTC session timezone", () => {
  // This module only ever uses the typed Prisma client (findMany/findFirst/
  // count with Date filters) — never $queryRaw/$executeRaw against a
  // TIMESTAMP(3) column — so it should be immune to the raw-SQL session-TZ
  // bug documented in AGENTS.md. This test verifies that claim directly
  // rather than assuming it.
  const separator = (url as string).includes("?") ? "&" : "?";
  const pinnedPrisma = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });

  afterAll(async () => {
    await pinnedPrisma.$disconnect();
  });

  it("gives the same result as UTC when the session timezone is pathological", async () => {
    await pinnedPrisma.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kathmandu'`);

    const store = await prisma.store.create({ data: { domain: `persist-tz-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
    for (const h of [96, 72, 48, 24, 0]) await makeCrawl(store.id, hoursAgo(h));
    const product = await makeProduct(store.id, { firstSeenAt: new Date("2026-01-01") });

    const result = await getProductPersistence(pinnedPrisma, store.id, product);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.ratio).toBe(1);
    expect(result.windowCrawlCount).toBe(5);
  });
});
