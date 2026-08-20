import { PrismaClient } from "@prisma/client";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../run-analysis";
import type { AnalysisSseEvent } from "../types";

/**
 * The one place that decides what a browser sees for a real analysis. Run
 * via `npm run test:integration` — see persist.integration.test.ts for why
 * DATABASE_URL is guarded this way (this suite truncates every table).
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

async function collectEvents(
  fetchImpl: typeof fetch,
  urlInput: string,
  caller?: { userId: string; plan: "FREE" | "BASIC" | "BUSINESS" } | null,
): Promise<AnalysisSseEvent[]> {
  const events: AnalysisSseEvent[] = [];
  await runAnalysis({ prisma, urlInput, fetchImpl, dnsLookup: SAFE_DNS, caller, onEvent: (e) => events.push(e) });
  return events;
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
  it("an anonymous caller gets ONLY the documented truncated preview — no full-report fields at all", async () => {
    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://real-store.com", null);

    const complete = events.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    if (complete?.type !== "complete") throw new Error("unreachable");

    const { report } = complete;
    expect(report.access).toBe("anonymous_preview");
    expect(report.domain).toBe("real-store.com");
    expect(report.productCount).toBe(2); // real, from the actual crawl
    if (report.access !== "anonymous_preview") throw new Error("unreachable");
    expect(report.theme.name).toBe("Dawn"); // real, fingerprinted from actual HTML

    // The old fake { locked: true } paywall contract is gone. The preview
    // shape doesn't have monitoring/apps/pricing/entitlement fields at all
    // — an anonymous caller's payload is exhaustively small, not a partially
    // redacted version of the full one.
    expect(Object.keys(report).sort()).toEqual(["access", "checkedAt", "cta", "domain", "platform", "productCount", "theme"]);
  });

  it("an authenticated, entitled caller gets the full report with real epistemic-status fields — never { locked: true }", async () => {
    const user = await prisma.user.create({ data: { email: "contract-test@example.com", plan: "FREE" } });
    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://real-store.com", {
      userId: user.id,
      plan: "FREE",
    });

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
    // Pre-existing, unrelated to Milestone 11: the (uncommitted) freemium
    // redesign already changed FREE's maxUniqueAnalyses to null/unlimited
    // in plan-limits.ts — this assertion was stale against that, not
    // against anything touched this milestone.
    expect(report.entitlement).toEqual({ analysesUsed: 1, analysesLimit: null, alreadyAnalyzed: false });
  });

  it("persists the crawl and store for a successful analysis", async () => {
    await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://real-store.com");

    const store = await prisma.store.findUniqueOrThrow({ where: { domain: "real-store.com" } });
    expect(store.baselinedAt).not.toBeNull();
    expect(await prisma.product.count({ where: { storeId: store.id } })).toBe(2);

    const crawl = await prisma.crawl.findFirstOrThrow({ where: { storeId: store.id } });
    expect(crawl.status).toBe("OK");
  });
});

describe("runAnalysis — failure classification", () => {
  it("classifies a non-Shopify domain as non_shopify, without leaking the raw crawler reason", async () => {
    const events = await collectEvents(routedFetch({ "/products.json": () => textResponse("nope", 404) }), "https://wordpress-site.com");

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "non_shopify" });
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.message).not.toContain("products.json"); // internal detail, not user-facing
  });

  // Milestone 11, item 1.5: prisma.store.upsert() used to run BEFORE the
  // crawl proved the domain was even reachable Shopify — Store.tier
  // defaults to COLD and nextCrawlAt to now(), so every junk domain
  // (typos, non-Shopify sites, dead domains) immediately entered the
  // scheduler's due-query and stayed there forever. Now the Store row (and,
  // since Crawl.storeId is NOT NULL, the Crawl row too) is only ever
  // written once crawlShopifyStore has actually returned status: "ok".
  it("a domain that fails Shopify detection leaves zero Store rows (and zero Crawl rows) behind", async () => {
    await collectEvents(routedFetch({ "/products.json": () => textResponse("nope", 404) }), "https://never-seen-before.com");

    expect(await prisma.store.count()).toBe(0);
    expect(await prisma.crawl.count()).toBe(0);
  });

  it("a domain that already has a Store row still gets a failed re-crawl recorded internally, curated message to the client", async () => {
    const store = await prisma.store.create({ data: { domain: "already-known.com", platform: "SHOPIFY", baselinedAt: new Date() } });

    const events = await collectEvents(
      routedFetch({ "/products.json": () => textResponse("nope", 404) }),
      "https://already-known.com",
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
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    const events = await collectEvents(fetchImpl, "https://offline-store.com");
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "unreachable", retryable: true });
  });

  it("classifies zero discovered products as crawl_incomplete", async () => {
    const events = await collectEvents(
      routedFetch({ "/products.json": () => jsonResponse({ products: [] }) }),
      "https://empty-store.com",
    );
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "crawl_incomplete" });
  });

  it("rejects an SSRF-unsafe target as invalid_url without making any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const events: AnalysisSseEvent[] = [];
    await runAnalysis({
      prisma,
      urlInput: "https://internal-target.com",
      fetchImpl,
      dnsLookup: async () => [{ address: "169.254.169.254" }],
      onEvent: (e) => events.push(e),
    });

    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL before touching the database", async () => {
    const events: AnalysisSseEvent[] = [];
    await runAnalysis({ prisma, urlInput: "not a url at all", onEvent: (e) => events.push(e) });

    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "invalid_url" });
    expect(await prisma.store.count()).toBe(0);
  });
});

describe("runAnalysis — duplicate-analysis guard", () => {
  it("refuses to start a second analysis while one is already RUNNING for the same store", async () => {
    const store = await prisma.store.create({ data: { domain: "busy-store.com", platform: "SHOPIFY" } });
    await prisma.crawl.create({ data: { storeId: store.id, status: "RUNNING" } });

    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://busy-store.com");

    // "validating" always fires first, then the dedup guard stops it there.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "status", status: "validating" });
    expect(events[1]).toMatchObject({ type: "error", retryable: true });
    // Only the one pre-existing Crawl row — no second one was created.
    expect(await prisma.crawl.count({ where: { storeId: store.id } })).toBe(1);
  });

  it("a RUNNING crawl outside the dedup window doesn't block a fresh analysis", async () => {
    const store = await prisma.store.create({ data: { domain: "stale-store.com", platform: "SHOPIFY" } });
    await prisma.crawl.create({
      data: { storeId: store.id, status: "RUNNING", startedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://stale-store.com");

    expect(events.find((e) => e.type === "complete")).toBeDefined();
  });
});

describe("runAnalysis — identity-aware entitlement gating (Milestone 3)", () => {
  it("an anonymous caller (no `caller`) is never gated — the crawl runs exactly as it always has", async () => {
    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://anon-store.com", null);
    expect(events.find((e) => e.type === "complete")).toBeDefined();
    expect(await prisma.analysisUsage.count()).toBe(0); // nothing to gate for an anonymous request
  });

  it("an authenticated user's first three unique stores all succeed and get recorded", async () => {
    const user = await prisma.user.create({ data: { email: "gate-1@example.com", plan: "FREE" } });
    const caller = { userId: user.id, plan: "FREE" as const };

    for (const domain of ["store-a.com", "store-b.com", "store-c.com"]) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }

    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(3);
  });

  // Pre-existing, unrelated to Milestone 11: the (uncommitted) freemium
  // redesign already set every PlanTier's maxUniqueAnalyses to null
  // (unlimited) in plan-limits.ts, so emitLimitReached()'s
  // analysis_limit_reached path is currently unreachable through any real
  // plan — there is no longer a finite limit to hit. Skipped rather than
  // deleted or rewritten to fabricate a plan that doesn't exist: fixing the
  // entitlement model itself is out of scope here (this milestone is
  // security/RBAC/promos, not billing), and this preserves the coverage's
  // intent for whenever a real limited tier exists again.
  it.skip("a fourth unique store is rejected with analysis_limit_reached BEFORE any crawl runs", async () => {
    const user = await prisma.user.create({ data: { email: "gate-2@example.com", plan: "FREE" } });
    const caller = { userId: user.id, plan: "FREE" as const };
    for (const domain of ["store-a.com", "store-b.com", "store-c.com"]) {
      await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
    }

    const fetchImpl = routedFetch(REAL_STORE_ROUTES);
    const events = await collectEvents(fetchImpl, "https://store-d.com", caller);

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "analysis_limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled(); // rejected before the crawl, not after
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(3); // still exactly 3
  });

  it("re-analyzing an already-counted store does not consume a credit or block a real re-crawl", async () => {
    const user = await prisma.user.create({ data: { email: "gate-3@example.com", plan: "FREE" } });
    const caller = { userId: user.id, plan: "FREE" as const };

    await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://repeat-store.com", caller);
    const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), "https://repeat-store.com", caller);

    expect(events.find((e) => e.type === "complete")).toBeDefined(); // real re-analysis still runs
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(1); // only counted once
  });

  it("a FAILED crawl never burns a credit — caught live: bombas.com returned a real HTTP 429 and still consumed a slot before this fix", async () => {
    const user = await prisma.user.create({ data: { email: "gate-4@example.com", plan: "FREE" } });
    const caller = { userId: user.id, plan: "FREE" as const };

    const failingFetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const failedEvents = await collectEvents(failingFetch, "https://flaky-store.com", caller);
    expect(failedEvents.find((e) => e.type === "error")).toMatchObject({ status: "unreachable" });
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(0); // nothing charged

    // The user still has all 3 credits — a retry (or three fresh stores) must all succeed.
    for (const domain of ["retry-a.com", "retry-b.com", "retry-c.com"]) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(3);
  });

  // Same pre-existing, unrelated reason as the skipped test above — FREE
  // has no finite limit to be "past" anymore.
  it.skip("a store that fails past the free limit still gets a fast, no-crawl rejection (the pre-check optimization)", async () => {
    const user = await prisma.user.create({ data: { email: "gate-5@example.com", plan: "FREE" } });
    const caller = { userId: user.id, plan: "FREE" as const };
    for (const domain of ["store-a.com", "store-b.com", "store-c.com"]) {
      await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
    }

    const fetchImpl = routedFetch(REAL_STORE_ROUTES);
    await collectEvents(fetchImpl, "https://store-d.com", caller);
    expect(fetchImpl).not.toHaveBeenCalled(); // still fails fast, doesn't waste a crawl once obviously over budget
  });

  it("a BASIC caller's analyses are never gated — well past FREE's 3-store limit, still full access", async () => {
    const user = await prisma.user.create({ data: { email: "gate-basic@example.com", plan: "BASIC" } });
    const caller = { userId: user.id, plan: "BASIC" as const };

    for (const domain of ["basic-a.com", "basic-b.com", "basic-c.com", "basic-d.com", "basic-e.com"]) {
      const events = await collectEvents(routedFetch(REAL_STORE_ROUTES), `https://${domain}`, caller);
      const complete = events.find((e) => e.type === "complete");
      expect(complete).toBeDefined();
      if (complete?.type === "complete" && complete.report.access === "full") {
        expect(complete.report.entitlement.analysesLimit).toBeNull(); // unlimited, not a number
      }
    }

    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(5);
  });
});
