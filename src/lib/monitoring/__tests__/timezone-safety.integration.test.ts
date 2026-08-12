import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runScheduledCrawl } from "../run-scheduled-crawl";
import { claimDueStores } from "../scheduler";

/**
 * Regression coverage for the raw-SQL UTC bug: TIMESTAMP(3) columns have no
 * timezone, so Postgres implicitly casts raw-bound Date parameters through
 * the *session's* TimeZone GUC on comparison/assignment — not UTC. This
 * project's own embedded test Postgres happened to default to a non-UTC
 * session zone (inherited from the host OS) and that's exactly how this was
 * first caught. Relying on that coincidence going forward is not a real
 * regression guard: a CI machine whose Postgres defaults to UTC would let a
 * reverted fix pass silently. So this suite pins a deliberately pathological,
 * fractional-hour session timezone via a dedicated single-connection client,
 * independent of whatever the environment happens to default to. See the
 * "Database time rule" section in AGENTS.md.
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

// connection_limit=1 pins every query this client makes to the same
// physical connection, so the SET TIME ZONE below reliably applies to
// everything the test does afterward — no pool-routing surprises.
const separator = url.includes("?") ? "&" : "?";
const prisma = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });

const PATHOLOGICAL_TZ = "Asia/Kathmandu"; // UTC+5:45 — a fractional offset a lucky hour-rounding bug can't accidentally survive
const SAFE_DNS = async () => [{ address: "8.8.8.8" }];
const NOW = new Date("2026-08-11T12:00:00Z");

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe(`SET TIME ZONE '${PATHOLOGICAL_TZ}'`);
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
    variants: [{ id: id * 10, title: "Default", sku: null, price: "79.00", compare_at_price: null, available: true, position: 1 }],
  };
}
function routesFor(products: unknown[]) {
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

describe(`raw-SQL timestamp writes stay correct under a non-UTC session timezone (${PATHOLOGICAL_TZ})`, () => {
  it("Product.firstSeenAt / lastSeenAt match the crawl's `now` exactly (diff/persist.ts bulk upsert)", async () => {
    const store = await prisma.store.create({ data: { domain: "tz-persist.com", platform: "SHOPIFY", tier: "WARM" } });

    await runScheduledCrawl({
      prisma,
      store,
      now: NOW,
      fetchImpl: routesFor([shopifyProduct(1)]),
      dnsLookup: SAFE_DNS,
    });

    const product = await prisma.product.findFirstOrThrow({ where: { storeId: store.id, externalId: "1" } });
    expect(product.firstSeenAt.getTime()).toBe(NOW.getTime());
    expect(product.lastSeenAt.getTime()).toBe(NOW.getTime());
  });

  it("claimDueStores respects the due/not-due boundary (monitoring/scheduler.ts claim query)", async () => {
    const due = await prisma.store.create({
      data: { domain: "tz-due.com", platform: "SHOPIFY", tier: "WARM", nextCrawlAt: new Date(Date.now() - 1000) },
    });
    await prisma.store.create({
      data: { domain: "tz-not-due.com", platform: "SHOPIFY", tier: "WARM", nextCrawlAt: new Date(Date.now() + 60_000) },
    });

    const claimed = await claimDueStores(prisma, new Date(), 10);

    expect(claimed.map((s) => s.id)).toEqual([due.id]);
  });

  it("claiming pushes nextCrawlAt far enough forward that an immediate second claim doesn't re-claim it", async () => {
    await prisma.store.create({ data: { domain: "tz-claimed-once.com", platform: "SHOPIFY", tier: "WARM" } });

    const first = await claimDueStores(prisma, new Date(), 10);
    const second = await claimDueStores(prisma, new Date(), 10);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
