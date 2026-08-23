import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { runAnonymousProbe } from "../anonymous-probe";
import type { AnalysisSseEvent } from "../types";
import type { verifyTurnstileToken } from "../../security/turnstile";

/**
 * Milestone 12 §1.3 (D3 amendment): the anonymous shallow-probe path.
 * Run via `npm run test:integration` — see persist.integration.test.ts for
 * why DATABASE_URL is guarded this way (this suite truncates every table).
 */

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () =>
  prisma.$executeRawUnsafe(`TRUNCATE "AnonymousAnalysis","AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`),
);

const SAFE_DNS = async () => [{ address: "8.8.8.8" }];
const ALWAYS_VERIFIED = async () => ({ ok: true as const });
const NEVER_VERIFIED = async () => ({ ok: false as const, reason: "missing_token" });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}
function shopifyProduct(id: number, price: string) {
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
    variants: [{ id: id * 10, title: "Default", sku: null, price, compare_at_price: null, available: true, position: 1 }],
  };
}

async function collect(args: {
  fetchImpl?: Mock;
  urlInput?: string;
  ipKey?: string;
  turnstileToken?: string | null;
  verifyTurnstile?: typeof verifyTurnstileToken | Mock;
  hourlyCeiling?: number;
}): Promise<AnalysisSseEvent[]> {
  const events: AnalysisSseEvent[] = [];
  await runAnonymousProbe({
    prisma,
    urlInput: args.urlInput ?? "https://real-store.com",
    ipKey: args.ipKey ?? "203.0.113.5",
    turnstileToken: args.turnstileToken ?? "a-real-token",
    fetchImpl: args.fetchImpl as unknown as typeof fetch,
    dnsLookup: SAFE_DNS,
    hourlyCeiling: args.hourlyCeiling ?? 500,
    verifyTurnstile: (args.verifyTurnstile ?? ALWAYS_VERIFIED) as typeof verifyTurnstileToken,
    onEvent: (e) => events.push(e),
  });
  return events;
}

describe("runAnonymousProbe — the shallow probe", () => {
  it("makes EXACTLY ONE outbound fetch — no pagination, no bestseller/collection/homepage extras", async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse({ products: [shopifyProduct(1, "29.00"), shopifyProduct(2, "49.00")] }));

    const events = await collect({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0];
    expect(String(calledUrl)).toContain("/products.json");
    expect(String(calledUrl)).toContain("page=1");

    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("unreachable");
    expect(complete.report).toMatchObject({
      access: "anonymous_probe",
      domain: "real-store.com",
      productCount: 2,
      priceRange: { minCents: 2900, maxCents: 4900 },
    });
  });

  it("never writes a Store row, even on success — D3's compensating control, distinct from and in addition to fix 1.5", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [shopifyProduct(1, "29.00")] }));
    await collect({ fetchImpl, urlInput: "https://success-store.com" });

    expect(await prisma.store.count()).toBe(0);
    expect(await prisma.crawl.count()).toBe(0);
  });

  // Phase 1 acceptance criterion, verbatim: "No Store row exists after an
  // anonymous analysis of a non-Shopify domain (regression against fix
  // 1.5)." The authenticated-path version of this exact invariant lives in
  // run-analysis.integration.test.ts; this is the anonymous-path version
  // Milestone 12 §1.3 explicitly requires to hold too.
  it("a non-Shopify domain leaves zero Store rows and zero Crawl rows (regression against fix 1.5, anonymous path)", async () => {
    const fetchImpl = vi.fn(async () => textResponse("nope", 404));

    const events = await collect({ fetchImpl, urlInput: "https://not-shopify.com" });

    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", status: "non_shopify" });
    expect(await prisma.store.count()).toBe(0);
    expect(await prisma.crawl.count()).toBe(0);
  });

  it("Turnstile verification failure is rejected BEFORE any outbound fetch — fail closed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [] }));

    const events = await collect({ fetchImpl, turnstileToken: null, verifyTurnstile: NEVER_VERIFIED });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "turnstile_failed" });
    expect(await prisma.anonymousAnalysis.count()).toBe(0); // never even recorded against the quota
  });

  it("an invalid/malformed URL is rejected before Turnstile verification or any fetch", async () => {
    const verifyTurnstile = vi.fn(NEVER_VERIFIED);
    const fetchImpl = vi.fn();

    const events = await collect({ fetchImpl, urlInput: "not a url at all", verifyTurnstile });

    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "invalid_url" });
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an SSRF-unsafe target as invalid_url without making any request", async () => {
    const fetchImpl = vi.fn();
    const events: AnalysisSseEvent[] = [];
    await runAnonymousProbe({
      prisma,
      urlInput: "https://internal-target.com",
      ipKey: "203.0.113.5",
      turnstileToken: "token",
      fetchImpl,
      dnsLookup: async () => [{ address: "169.254.169.254" }],
      hourlyCeiling: 500,
      verifyTurnstile: ALWAYS_VERIFIED,
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "invalid_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the 4th probe from the same IP in 24h is rejected with anonymous_limit_reached", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [shopifyProduct(1, "10.00")] }));

    for (let i = 0; i < 3; i++) {
      const events = await collect({ fetchImpl, urlInput: `https://store-${i}.com`, ipKey: "203.0.113.77" });
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }

    fetchImpl.mockClear();
    const events = await collect({ fetchImpl, urlInput: "https://store-3.com", ipKey: "203.0.113.77" });
    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "anonymous_limit_reached" });
    expect(fetchImpl).not.toHaveBeenCalled(); // recorded (and rejected) before the fetch — see the module's own comment on why
  });

  it("a spoofed x-forwarded-for-derived ipKey does not reset a different real IP's quota (end-to-end sanity, ledger-level regression covered in anonymous-analysis.integration.test.ts)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [shopifyProduct(1, "10.00")] }));
    for (let i = 0; i < 3; i++) {
      await collect({ fetchImpl, urlInput: `https://a-${i}.com`, ipKey: "203.0.113.99" });
    }
    // A GENUINELY different real IP is unaffected — proves buckets are per-ipKey, not global.
    const events = await collect({ fetchImpl, urlInput: "https://b.com", ipKey: "198.51.100.10" });
    expect(events.find((e) => e.type === "complete")).toBeDefined();
  });

  it("returns service_unavailable once the global hourly circuit breaker ceiling is reached, even for an IP under its own quota", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [shopifyProduct(1, "10.00")] }));

    for (let i = 0; i < 2; i++) {
      const events = await collect({ fetchImpl, urlInput: `https://s-${i}.com`, ipKey: `203.0.113.${i}`, hourlyCeiling: 2 });
      expect(events.find((e) => e.type === "complete")).toBeDefined();
    }

    fetchImpl.mockClear();
    const events = await collect({ fetchImpl, urlInput: "https://s-over.com", ipKey: "203.0.113.250", hourlyCeiling: 2 });
    expect(events.find((e) => e.type === "error")).toMatchObject({ status: "service_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Deliberately DIFFERENT from the authenticated path's behavior: a full
  // crawl treats zero products (after attempting full pagination) as
  // crawl_incomplete, because that heuristic exists to catch a genuinely
  // broken multi-page crawl. A single-page probe has no pagination to have
  // gone wrong — a 200 with a valid, empty products array is itself a
  // legitimate "confirmed Shopify, zero products on page 1" result, not a
  // failure to surface as an error.
  it("a valid but empty products.json page 1 is a successful probe result (0 products), not an error — no Store row either way", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [] }));
    const events = await collect({ fetchImpl, urlInput: "https://empty-store.com" });
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const complete = events.find((e) => e.type === "complete");
    if (complete?.type !== "complete") throw new Error("unreachable");
    expect(complete.report).toMatchObject({ productCount: 0, priceRange: { minCents: null, maxCents: null } });
    expect(await prisma.store.count()).toBe(0);
  });
});
