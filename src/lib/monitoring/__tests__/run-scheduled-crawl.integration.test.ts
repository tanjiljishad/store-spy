import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledCrawl } from "../run-scheduled-crawl";

/**
 * The exact scenarios the milestone brief calls out by name: baseline
 * suppresses PRODUCT_ADDED, the next real crawl detects real additions,
 * an incomplete/shrunk crawl never fires mass removals, a price move fires
 * exactly one event, and a retried scheduled crawl never duplicates state.
 * Run via `npm run test:integration` — see persist.integration.test.ts for
 * why DATABASE_URL is guarded this way (this suite TRUNCATEs every table).
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
const SAFE_DNS = async () => [{ address: "8.8.8.8" }];
const NOW = new Date("2026-08-11T12:00:00Z");

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}
function shopifyProduct(id: number, overrides: Record<string, unknown> = {}) {
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
    variants: [{ id: id * 10, title: "Default", sku: null, price: "79.00", compare_at_price: null, available: true, position: 1 }],
    ...overrides,
  };
}

function routesFor(products: unknown[], extras: Partial<Record<string, () => Response>> = {}) {
  const routes: Record<string, () => Response> = {
    "/products.json": () => jsonResponse({ products }),
    "/collections/all/products.json": () => jsonResponse({ products: [] }),
    "/collections.json": () => jsonResponse({ collections: [] }),
    "/": () => textResponse("<html></html>"),
    ...extras,
  };
  return vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    return routes[u.pathname]?.() ?? textResponse("not found", 404);
  }) as unknown as typeof fetch;
}

async function makeStore(domain: string) {
  return prisma.store.create({ data: { domain, platform: "SHOPIFY", tier: "WARM" } });
}

describe("runScheduledCrawl — baseline and additions", () => {
  it("the first crawl establishes a baseline with zero alertable PRODUCT_ADDED events", async () => {
    const store = await makeStore("baseline.com");

    const outcome = await runScheduledCrawl({
      prisma,
      store,
      now: NOW,
      fetchImpl: routesFor([shopifyProduct(1), shopifyProduct(2)]),
      dnsLookup: SAFE_DNS,
    });

    expect(outcome.outcome).toBe("ok");
    const added = await prisma.event.findMany({
      where: { storeId: store.id, eventType: "PRODUCT_ADDED", backfilled: false },
    });
    expect(added).toHaveLength(0);

    const afterStore = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(afterStore.baselinedAt).not.toBeNull();
  });

  it("the second crawl detects real product additions", async () => {
    const store = await makeStore("grows.com");
    await runScheduledCrawl({
      prisma,
      store,
      now: NOW,
      fetchImpl: routesFor([shopifyProduct(1), shopifyProduct(2)]),
      dnsLookup: SAFE_DNS,
    });

    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const nineProducts = Array.from({ length: 9 }, (_, i) => shopifyProduct(i + 1));
    const outcome = await runScheduledCrawl({
      prisma,
      store,
      now: later,
      fetchImpl: routesFor(nineProducts),
      dnsLookup: SAFE_DNS,
    });

    expect(outcome.outcome).toBe("ok");
    const added = await prisma.event.findMany({
      where: { storeId: store.id, eventType: "PRODUCT_ADDED", backfilled: false },
    });
    expect(added).toHaveLength(7); // 9 - 2
  });
});

describe("runScheduledCrawl — incomplete crawl safety", () => {
  it("a catalog that shrinks past the threshold aborts instead of firing mass removals", async () => {
    const store = await makeStore("shrinks.com");
    const twelveProducts = Array.from({ length: 12 }, (_, i) => shopifyProduct(i + 1));
    await runScheduledCrawl({ prisma, store, now: NOW, fetchImpl: routesFor(twelveProducts), dnsLookup: SAFE_DNS });

    // Second crawl "sees" only 2 of the 12 — an 83% shrink, well past the guard's 40% threshold.
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const outcome = await runScheduledCrawl({
      prisma,
      store,
      now: later,
      fetchImpl: routesFor([shopifyProduct(1), shopifyProduct(2)]),
      dnsLookup: SAFE_DNS,
    });

    expect(outcome.outcome).toBe("failed");
    const removed = await prisma.event.findMany({ where: { storeId: store.id, eventType: "PRODUCT_REMOVED" } });
    expect(removed).toHaveLength(0);

    // The 12 original products must still be ACTIVE — nothing was torn down.
    const active = await prisma.product.count({ where: { storeId: store.id, status: "ACTIVE" } });
    expect(active).toBe(12);
  });
});

describe("runScheduledCrawl — price changes", () => {
  it("a real price move fires exactly one price event", async () => {
    const store = await makeStore("repriced.com");
    await runScheduledCrawl({
      prisma,
      store,
      now: NOW,
      fetchImpl: routesFor([shopifyProduct(1, { variants: [{ id: 10, title: "Default", sku: null, price: "79.00", compare_at_price: null, available: true, position: 1 }] })]),
      dnsLookup: SAFE_DNS,
    });

    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await runScheduledCrawl({
      prisma,
      store,
      now: later,
      fetchImpl: routesFor([shopifyProduct(1, { variants: [{ id: 10, title: "Default", sku: null, price: "69.00", compare_at_price: null, available: true, position: 1 }] })]),
      dnsLookup: SAFE_DNS,
    });

    const priceEvents = await prisma.event.findMany({
      where: { storeId: store.id, eventType: { in: ["PRICE_DROP", "PRICE_INCREASE"] } },
    });
    expect(priceEvents).toHaveLength(1);
    expect(priceEvents[0].eventType).toBe("PRICE_DROP");
  });
});

describe("runScheduledCrawl — technology changes (reuses the existing fingerprinter and entity state machine)", () => {
  it("detects a theme change", async () => {
    const store = await makeStore("rebuilt.com");
    const homepage = (theme: string) => textResponse(`<html><script>Shopify.theme={"name":"${theme}"};</script></html>`);

    await runScheduledCrawl({
      prisma,
      store,
      now: NOW,
      fetchImpl: routesFor([shopifyProduct(1)], { "/": () => homepage("Dawn") }),
      dnsLookup: SAFE_DNS,
    });

    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await runScheduledCrawl({
      prisma,
      store,
      now: later,
      fetchImpl: routesFor([shopifyProduct(1)], { "/": () => homepage("Impulse") }),
      dnsLookup: SAFE_DNS,
    });

    const themeEvents = await prisma.event.findMany({ where: { storeId: store.id, eventType: "THEME_CHANGED" } });
    expect(themeEvents).toHaveLength(1);

    const afterStore = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(afterStore.themeName).toBe("Impulse");
  });

  it("detects a genuinely new app, and does not fire a false APP_REMOVED on a single missed fetch (flap suppression preserved)", async () => {
    const store = await makeStore("apps.com");
    const withKlaviyo = () => textResponse(`<html><script src="https://static.klaviyo.com/x.js"></script></html>`);
    const withoutApps = () => textResponse("<html></html>");

    // Baseline: klaviyo present.
    await runScheduledCrawl({
      prisma,
      store,
      now: NOW,
      fetchImpl: routesFor([shopifyProduct(1)], { "/": withKlaviyo }),
      dnsLookup: SAFE_DNS,
    });

    // Crawl 2: klaviyo's script tag doesn't appear on this homepage fetch —
    // a single flap must NOT fire APP_REMOVED.
    const day2 = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await runScheduledCrawl({
      prisma,
      store,
      now: day2,
      fetchImpl: routesFor([shopifyProduct(1)], { "/": withoutApps }),
      dnsLookup: SAFE_DNS,
    });

    let appEvents = await prisma.event.findMany({ where: { storeId: store.id, eventType: { in: ["APP_ADDED", "APP_REMOVED"] } } });
    expect(appEvents).toHaveLength(0); // no false event from the single flap

    const klaviyo = await prisma.storeEntity.findFirstOrThrow({ where: { storeId: store.id, kind: "APP", key: "klaviyo" } });
    expect(klaviyo.status).toBe("MISSING"); // streak advanced, but silently

    // Crawl 3: a genuinely new app shows up.
    const day3 = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const withJudgeMe = () => textResponse(`<html><script src="https://cdn-widgetsrepo.judge.me/assets/widget.js"></script></html>`);
    await runScheduledCrawl({
      prisma,
      store,
      now: day3,
      fetchImpl: routesFor([shopifyProduct(1)], { "/": withJudgeMe }),
      dnsLookup: SAFE_DNS,
    });

    appEvents = await prisma.event.findMany({ where: { storeId: store.id, eventType: "APP_ADDED" } });
    expect(appEvents).toHaveLength(1);
    expect(appEvents[0].entityKey).toBe("judgeme");
  });
});

describe("runScheduledCrawl — idempotent retry", () => {
  it("crawling the same real-world state twice does not duplicate events or corrupt product state", async () => {
    const store = await makeStore("retried.com");
    const products = [shopifyProduct(1), shopifyProduct(2)];
    await runScheduledCrawl({ prisma, store, now: NOW, fetchImpl: routesFor(products), dnsLookup: SAFE_DNS });

    const beforeRetry = await prisma.product.findFirstOrThrow({ where: { storeId: store.id, externalId: "1" } });
    const eventsBefore = await prisma.event.count({ where: { storeId: store.id } });

    // Same store, same observed state, a later "retry" crawl (e.g. the
    // scheduler re-claiming after a worker crash) — nothing actually changed.
    const later = new Date(NOW.getTime() + 60_000);
    const outcome = await runScheduledCrawl({ prisma, store, now: later, fetchImpl: routesFor(products), dnsLookup: SAFE_DNS });

    expect(outcome.outcome).toBe("short_circuited");
    const afterRetry = await prisma.product.findFirstOrThrow({ where: { storeId: store.id, externalId: "1" } });
    const eventsAfter = await prisma.event.count({ where: { storeId: store.id } });

    expect(eventsAfter).toBe(eventsBefore); // no duplicate events
    expect(afterRetry.firstSeenAt.toISOString()).toBe(beforeRetry.firstSeenAt.toISOString()); // identity preserved
    expect(afterRetry.id).toBe(beforeRetry.id);
  });
});
