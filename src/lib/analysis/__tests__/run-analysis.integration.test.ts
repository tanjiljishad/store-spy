import { PrismaClient } from "@prisma/client";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../run-analysis";
import type { AnalysisSseEvent } from "../types";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/**
 * The one place that decides what a browser sees for a real, AUTHENTICATED
 * analysis. Run via `npm run test:integration` — see persist.integration.test.ts
 * for why DATABASE_URL is guarded this way (this suite truncates every table).
 *
 * Milestone 12 §1.3 (D3 amendment): `caller` is now REQUIRED — an anonymous
 * caller no longer reaches runAnalysis() at all; it gets a completely
 * different, much cheaper operation (analysis/anonymous-probe.ts's
 * runAnonymousProbe()), covered by anonymous-probe.integration.test.ts, not
 * this file. Every test below that used to omit `caller` (defaulting to
 * anonymous) now supplies a real one — that's a mechanical fix for the
 * signature change, not a change in what those tests are asserting (crawl
 * mechanics: SSRF rejection, malformed URL, dedup, failure classification
 * — none of that is caller-identity-dependent).
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
    `TRUNCATE "AnalysisUsage","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Session","Account","User","Store" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

// SAFE_DNS stands in for real DNS resolution — see shopify.test.ts for why
// unit/integration tests inject this instead of hitting the network.
const SAFE_DNS = async () => [{ address: "8.8.8.8" }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function shopifyProduct(id: number) {
  return {
    id,
    handle: `product-${id}`,
    title: `Product ${id}`,
    vendor: "Acme",
    product_type: "Gadget",
    tags: "",
    created_at: "2026-01-01T00:00:00Z",
    published_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    variants: [{ id: id * 10, title: "Default", sku: null, price: "29.00", compare_at_price: null, available: true, position: 1 }],
  };
}

function routedFetch(routes: Record<string, (url: URL) => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL) => {
    const u = new URL(String(input));
    const handler = routes[u.pathname];
    return handler ? handler(u) : textResponse("not found", 404);
  }) as unknown as typeof fetch;
}

type Caller = { userId: string; plan: "FREE" | "BASIC" | "BUSINESS" };

async function collectEvents(fetchImpl: typeof fetch, urlInput: string, caller: Caller): Promise<AnalysisSseEvent[]> {
  const events: AnalysisSseEvent[] = [];
  await runAnalysis({ prisma, urlInput, fetchImpl, dnsLookup: SAFE_DNS, caller, onEvent: (e) => events.push(e) });
  return events;
}

async function makeCaller(plan: Caller["plan"] = "FREE"): Promise<Caller> {
  const user = await makeStoreSpyUser(prisma, { email: `${Math.random().toString(36).slice(2)}@example.com`, plan });
  return { userId: user.id, plan };
}

const REAL_STORE_ROUTES = {
  "/products.json": () => jsonResponse({ products: [shopifyProduct(1), shopifyProduct(2)] }),
  "/collections/all/products.json": () => jsonResponse({ products: [] }),
  "/collections.json": () => jsonResponse({ collections: [{ handle: "all" }] }),
  "/": () =>
    textResponse(
      `<html><script>Shopify.theme={"name":"Dawn"};</script><script src="https://static.klaviyo.com/x.js"></script><script src="https://cdn-widgetsrepo.judge.me/assets/widget.js"></script></html>`,
    ),
};

describe("runAnalysis — the security contract", () => {
  it("an authenticated, entitled caller gets the full report with real epistemic-status fields — never { locked: true }", async () => {
    const caller = await makeCaller("FREE");
    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://real-store.com", caller);

    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("unreachable");
    const { report } = complete;

    expect(report.access).toBe("full");
    if (report.access !== "full") throw new Error("unreachable");

    // Observed, real values — computed from the actual crawl, not modeled.
    expect(report.productCount).toEqual({ status: "OBSERVED", value: 2 });
    expect(report.theme).toEqual({ status: "OBSERVED", value: { name: "Dawn", version: null } });
    expect(report.apps).toEqual({ status: "OBSERVED", value: expect.arrayContaining(["klaviyo", "judgeme"]) });

    // Genuinely unbuilt fields say so honestly — never a paywall tease, never a fabricated number.
    for (const field of [report.revenue, report.traffic, report.reviewVelocity]) {
      expect(field.status).toBe("UNAVAILABLE");
      if (field.status === "UNAVAILABLE") expect(field.reason.length).toBeGreaterThan(0);
    }

    // Belt and braces: the old paywall shape cannot exist anywhere in this object.
    expect(JSON.stringify(report)).not.toContain("locked");

    expect(report.monitoring).toMatchObject({ tier: "COLD", active: true, totalCrawls: 1 });
    // Milestone 12 §1.1: FREE's real windowed limit is 10/24h, not unlimited.
    expect(report.entitlement.analysesUsed).toBe(1);
    expect(report.entitlement.analysesLimit).toBe(10);
    expect(report.entitlement.alreadyAnalyzed).toBe(false);
    expect(typeof report.entitlement.resetsAt).toBe("string");
  });

  it("persists the crawl and store for a successful analysis", async () => {
    const caller = await makeCaller();
    await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://real-store.com", caller);

    const store = await prisma.store.findUniqueOrThrow({ where: { domain: "real-store.com" } });
    expect(store.baselinedAt).not.toBeNull();
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(2);

    const crawl = await prisma.crawl.findFirstOrThrow({ where: { storeId: store.id } });
    expect(crawl.status).toBe("OK");
  });
});

describe("runAnalysis — failure classification", () => {
  it("classifies a non-Shopify domain as non_shopify, without leaking the raw crawler reason", async () => {
    const caller = await makeCaller();
    const events = await collectEvents(routedFetch({ "/products.json": () => textResponse("nope", 404) }), "https://wordpress-site.com", caller);

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "non_shopify" });
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.message).not.toContain("products.json"); // internal detail, not user-facing
  });

  // Milestone 11, item 1.5, PRESERVED here per Milestone 12's explicit
  // instruction not to regress it: prisma.store.upsert() used to run BEFORE
  // the crawl proved the domain was even reachable Shopify. Now the Store
  // row (and, since Crawl.storeId is NOT NULL, the Crawl row too) is only
  // ever written once crawlShopifyStore has actually returned status: "ok".
  // See anonymous-probe.integration.test.ts for the SAME invariant on the
  // anonymous path, which Milestone 12 §1.3 explicitly preserves too.
  it("a domain that fails Shopify detection leaves zero Store rows (and zero Crawl rows) behind", async () => {
    const caller = await makeCaller();
    await collectEvents(routedFetch({ "/products.json": () => textResponse("nope", 404) }), "https://never-seen-before.com", caller);

    expect(await prisma.store.count()).toBe(0);
    expect(await prisma.crawl.count()).toBe(0);
  });

  it("a domain that already has a Store row still gets a failed re-crawl recorded internally, curated message to the client", async () => {
    const caller = await makeCaller();
    const store = await prisma.store.create({ data: { domain: "already-known.com", platform: "SHOPIFY", baselinedAt: new Date() } });

    const events = await collectEvents(
      routedFetch({ "/products.json": () => textResponse("nope", 404) }),
      "https://already-known.com",
      caller,
    );

    const error = events.find((e) => e.type === "error");
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.message).not.toContain("products.json"); // still never leaked to the client

    // ...but IS recorded for us internally, same as before this milestone —
    // an already-known store's failure history/backoff must keep working.
    const crawl = await prisma.crawl.findFirstOrThrow({ where: { storeId: store.id } });
    expect(crawl.status).toBe("FAILED");
    expect(crawl.errorMessage).toContain("products.json");

    const updatedStore = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(updatedStore.failureStreak).toBeGreaterThan(0); // backoff/demotion path still ran
  });

  it("classifies a network failure as unreachable and retryable", async () => {
    const caller = await makeCaller();
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const events = await collectEvents(fetchImpl, "https://offline-store.com", caller);
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "unreachable", retryable: true });
  });

  it("classifies zero discovered products as crawl_incomplete", async () => {
    const caller = await makeCaller();
    const events = await collectEvents(
      routedFetch({ "/products.json": () => jsonResponse({ products: [] }) }),
      "https://empty-store.com",
      caller,
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "crawl_incomplete" });
  });

  it("rejects an SSRF-unsafe target as invalid_url without making any request", async () => {
    const caller = await makeCaller();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const events: AnalysisSseEvent[] = [];
    await runAnalysis({
      prisma,
      urlInput: "https://internal-target.com",
      fetchImpl,
      dnsLookup: async () => [{ address: "169.254.169.254" }],
      caller,
      onEvent: (e) => events.push(e),
    });

    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL before touching the database", async () => {
    const caller = await makeCaller();
    const events: AnalysisSseEvent[] = [];
    await runAnalysis({ prisma, urlInput: "not a url at all", caller, onEvent: (e) => events.push(e) });

    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "invalid_url" });
    expect(await prisma.store.count()).toBe(0);
  });
});

describe("runAnalysis — duplicate-analysis guard", () => {
  it("refuses to start a second analysis while one is already RUNNING for the same store", async () => {
    const caller = await makeCaller();
    const store = await prisma.store.create({ data: { domain: "busy-store.com", platform: "SHOPIFY" } });
    await prisma.crawl.create({ data: { storeId: store.id, status: "RUNNING" } });

    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://busy-store.com", caller);

    // "validating" always fires first, then the dedup guard stops it there.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "status", status: "validating" });
    expect(events[1]).toMatchObject({ type: "error", retryable: true });
    // Only the one pre-existing Crawl row — no second one was created.
    expect(await prisma.crawl.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("a RUNNING crawl outside the dedup window doesn't block a fresh analysis", async () => {
    const caller = await makeCaller();
    const store = await prisma.store.create({ data: { domain: "stale-store.com", platform: "SHOPIFY" } });
    await prisma.crawl.create({
      data: { storeId: store.id, status: "RUNNING", startedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://stale-store.com", caller);

    expect(events.find((e) => e.type === "complete")).toBeDefined();
  });
});

describe("runAnalysis — identity-aware entitlement gating (Milestone 12 §1.1/§1.2 windowed model)", () => {
  it("an authenticated user's first several unique stores all succeed and get recorded", async () => {
    const caller = await makeCaller();

    for (const domain of ["store-a.com", "store-b.com", "store-c.com"]) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }

    expect(await prisma.analysisUsage.count({ where: { userId: caller.userId } })).toBe(3);
  });

  // Un-skipped from Milestone 11: that skip was because every plan had
  // maxUniqueAnalyses: null (unlimited) at the time. Milestone 12 §1.1
  // reintroduces a real, finite windowed limit (FREE: 10/24h), making this
  // path reachable again — this is Phase 1's own 2nd acceptance-criterion
  // bullet, verified end to end through the full runAnalysis() pipeline
  // (not just analysis-usage.ts directly).
  it("the 11th unique store in 24h is rejected with analysis_limit_reached BEFORE any crawl runs — the 10th succeeds", async () => {
    const caller = await makeCaller();
    for (let i = 0; i < 10; i++) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://store-${i}.com`, caller);
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }

    const fetchImpl = routedFetch(REAL_STORE_ROUTES);
    const events = await collectEvents(fetchImpl, "https://store-11.com", caller);

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "analysis_limit_reached" });
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.limitReached).toMatchObject({ code: "LIMIT_REACHED", limit: "ANALYSES_PER_DAY", current: 10, max: 10, upgradeTo: "BASIC" });
    expect(fetchImpl).not.toHaveBeenCalled(); // rejected before the crawl, not after
    expect(await prisma.analysisUsage.count({ where: { userId: caller.userId } })).toBe(10); // still exactly 10
  });

  it("D2: re-analyzing an already-counted store WITHIN the window does not consume a credit or block a real re-crawl", async () => {
    const caller = await makeCaller();

    await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://repeat-store.com", caller);
    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://repeat-store.com", caller);

    expect(events.find((e) => e.type === "complete")).toBeDefined(); // real re-analysis still runs
    expect(await prisma.analysisUsage.count({ where: { userId: caller.userId } })).toBe(1); // only counted once
  });

  it("a FAILED crawl never burns a credit — caught live: bombas.com returned a real HTTP 429 and still consumed a slot before this fix", async () => {
    const caller = await makeCaller();

    const failingFetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const failedEvents = await collectEvents(failingFetch, "https://flaky-store.com", caller);
    expect(failedEvents.find((e) => e.type === "error")).toMatchObject({ status: "unreachable" });
    expect(await prisma.analysisUsage.count({ where: { userId: caller.userId } })).toBe(0); // nothing charged

    // The user still has all 10 credits — a retry (or three fresh stores) must all succeed.
    for (const domain of ["retry-a.com", "retry-b.com", "retry-c.com"]) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }
    expect(await prisma.analysisUsage.count({ where: { userId: caller.userId } })).toBe(3);
  });

  // Un-skipped from Milestone 11 for the same reason as the 11th-store test
  // above — a real, finite limit exists again to be "past."
  it("a store analyzed past the free limit still gets a fast, no-crawl rejection (the pre-check optimization)", async () => {
    const caller = await makeCaller();
    for (let i = 0; i < 10; i++) {
      await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://store-${i}.com`, caller);
    }

    const fetchImpl = routedFetch(REAL_STORE_ROUTES);
    await collectEvents(fetchImpl, "https://store-11.com", caller);
    expect(fetchImpl).not.toHaveBeenCalled(); // still fails fast, doesn't waste a crawl once obviously over budget
  });

  it("a BASIC caller has a real, higher (not unlimited) daily limit — 50/24h, per the Milestone 12 §1.1 matrix", async () => {
    const caller = await makeCaller("BASIC");

    for (const domain of ["basic-a.com", "basic-b.com", "basic-c.com", "basic-d.com", "basic-e.com"]) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
      const complete = events.find((e) => e.type === "complete");
      expect(complete).toBeDefined();
      if (complete?.type === "complete" && complete.report.access === "full") {
        expect(complete.report.entitlement.analysesLimit).toBe(50); // real, not unlimited
      }
    }

    expect(await prisma.analysisUsage.count({ where: { userId: caller.userId } })).toBe(5);
  });
});
