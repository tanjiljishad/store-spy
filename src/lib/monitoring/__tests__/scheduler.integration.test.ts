import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { claimDueStores, runSchedulerTick } from "../scheduler";
import { MAX_CONSECUTIVE_FAILURES } from "../policy";

/**
 * The scheduler's whole safety story is the claim transaction — this proves
 * it against a real Postgres, not just reasoning about the SQL. Run via
 * `npm run test:integration` — see persist.integration.test.ts for why
 * DATABASE_URL is guarded this way (this suite TRUNCATEs every table).
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
    variants: [{ id: id * 10, title: "Default", sku: null, price: "10.00", compare_at_price: null, available: true, position: 1 }],
  };
}
const ALWAYS_ONE_PRODUCT = {
  "/products.json": () => jsonResponse({ products: [shopifyProduct(1)] }),
  "/collections/all/products.json": () => jsonResponse({ products: [] }),
  "/collections.json": () => jsonResponse({ collections: [] }),
  "/": () => textResponse("<html></html>"),
};
function routedFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    return routes[u.pathname]?.() ?? textResponse("not found", 404);
  }) as unknown as typeof fetch;
}
const ALWAYS_404 = { "/products.json": () => textResponse("nope", 404) };

async function makeStore(domain: string, overrides: { tier?: string; nextCrawlAt?: Date; failureStreak?: number } = {}) {
  return prisma.store.create({
    data: {
      domain,
      platform: "SHOPIFY",
      tier: (overrides.tier ?? "WARM") as never,
      nextCrawlAt: overrides.nextCrawlAt ?? new Date(Date.now() - 1000),
      failureStreak: overrides.failureStreak ?? 0,
    },
  });
}

describe("claimDueStores", () => {
  it("claims stores that are due and ignores ones that aren't", async () => {
    const due = await makeStore("due.com", { nextCrawlAt: new Date(Date.now() - 1000) });
    await makeStore("not-due.com", { nextCrawlAt: new Date(Date.now() + 60_000) });

    const claimed = await claimDueStores(prisma, new Date(), 10);

    expect(claimed.map((s) => s.id)).toEqual([due.id]);
  });

  it("never claims a DISABLED store even if nextCrawlAt is due", async () => {
    await makeStore("disabled.com", { tier: "DISABLED", nextCrawlAt: new Date(Date.now() - 1000) });

    const claimed = await claimDueStores(prisma, new Date(), 10);

    expect(claimed).toHaveLength(0);
  });

  it("respects batchSize", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => makeStore(`batch-${i}.com`)));

    const claimed = await claimDueStores(prisma, new Date(), 2);

    expect(claimed).toHaveLength(2);
  });

  it("pushes nextCrawlAt forward on claim, so an immediate second claim doesn't re-claim it", async () => {
    await makeStore("claimed-once.com");

    const first = await claimDueStores(prisma, new Date(), 10);
    const second = await claimDueStores(prisma, new Date(), 10);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("two concurrent claims over the same due stores never overlap", async () => {
    const stores = await Promise.all(Array.from({ length: 6 }, (_, i) => makeStore(`concurrent-${i}.com`)));

    const [batch1, batch2] = await Promise.all([
      claimDueStores(prisma, new Date(), 10),
      claimDueStores(prisma, new Date(), 10),
    ]);

    const ids1 = new Set(batch1.map((s) => s.id));
    const ids2 = new Set(batch2.map((s) => s.id));
    const overlap = [...ids1].filter((id) => ids2.has(id));

    expect(overlap).toHaveLength(0);
    // Together they account for every due store exactly once — nothing lost, nothing duplicated.
    expect(ids1.size + ids2.size).toBe(stores.length);
  });
});

describe("runSchedulerTick", () => {
  it("crawls a claimed store and schedules its next check", async () => {
    const store = await makeStore("tick-success.com", { tier: "WARM" });

    const result = await runSchedulerTick({
      prisma,
      fetchImpl: routedFetch(ALWAYS_ONE_PRODUCT),
      dnsLookup: SAFE_DNS,
    });

    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.baselinedAt).not.toBeNull();
    expect(after.nextCrawlAt.getTime()).toBeGreaterThan(Date.now()); // scheduled into the future
    expect(after.failureStreak).toBe(0);

    const crawl = await prisma.crawl.findFirstOrThrow({ where: { storeId: store.id } });
    expect(crawl.trigger).toBe("SCHEDULED");
    expect(crawl.status).toBe("OK");
  });

  it("a failing crawl backs off and increments failureStreak, without demoting on the first failure", async () => {
    await makeStore("tick-fail.com");

    const result = await runSchedulerTick({ prisma, fetchImpl: routedFetch(ALWAYS_404), dnsLookup: SAFE_DNS });

    expect(result.failed).toBe(1);
    const after = await prisma.store.findFirstOrThrow({ where: { domain: "tick-fail.com" } });
    expect(after.failureStreak).toBe(1);
    expect(after.tier).not.toBe("DISABLED");
    expect(after.nextCrawlAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("demotes to DISABLED after enough consecutive scheduled failures, and stops being claimed", async () => {
    await makeStore("tick-give-up.com", { failureStreak: MAX_CONSECUTIVE_FAILURES - 1 });

    await runSchedulerTick({ prisma, fetchImpl: routedFetch(ALWAYS_404), dnsLookup: SAFE_DNS });

    const after = await prisma.store.findFirstOrThrow({ where: { domain: "tick-give-up.com" } });
    expect(after.tier).toBe("DISABLED");

    // Force nextCrawlAt due again and confirm the scheduler still won't touch it.
    await prisma.store.update({ where: { id: after.id }, data: { nextCrawlAt: new Date(Date.now() - 1000) } });
    const nextTick = await runSchedulerTick({ prisma, fetchImpl: routedFetch(ALWAYS_404), dnsLookup: SAFE_DNS });
    expect(nextTick.claimed).toBe(0);
  });

  it("one store's unexpected exception doesn't stop the rest of the batch", async () => {
    await makeStore("tick-throws.com");
    await makeStore("tick-fine.com");

    const throwingFetch = vi.fn(async (input: string | URL) => {
      const u = new URL(String(input));
      if (u.hostname === "tick-throws.com") throw new Error("boom");
      return ALWAYS_ONE_PRODUCT[u.pathname as keyof typeof ALWAYS_ONE_PRODUCT]?.() ?? textResponse("not found", 404);
    }) as unknown as typeof fetch;

    const result = await runSchedulerTick({ prisma, fetchImpl: throwingFetch, dnsLookup: SAFE_DNS });

    expect(result.claimed).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });
});
