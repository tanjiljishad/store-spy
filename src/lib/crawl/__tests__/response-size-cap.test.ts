import { describe, expect, it, vi } from "vitest";
import { crawlShopifyStore, type CrawlOptions } from "../shopify";
import type { ShopifyProduct } from "../normalize";
import type { DnsLookup } from "../../security/ssrf-guard";

/**
 * Milestone 8 Sub-phase B — the crawler response-size cap. Uses a small,
 * test-friendly `maxResponseBytes` override (the crawl option added this
 * sub-phase) rather than the real 10 MB production default, so these tests
 * can cross the boundary with compact fixtures instead of generating
 * megabytes of data.
 */

const SAFE_DNS: DnsLookup = async () => [{ address: "8.8.8.8" }];
function crawl(domain: string, opts: CrawlOptions = {}) {
  return crawlShopifyStore(domain, { dnsLookup: SAFE_DNS, requestDelayMs: 0, ...opts });
}

function product(id: number, overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
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
    variants: [{ id: id * 10, title: "Default", sku: null, price: "10.00", compare_at_price: null, available: true, position: 1 }],
    ...overrides,
  };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const NOOP_EXTRAS = {
  "/collections/all/products.json": () => new Response(JSON.stringify({ products: [] }), { headers: { "content-type": "application/json" } }),
  "/collections.json": () => new Response(JSON.stringify({ collections: [] }), { headers: { "content-type": "application/json" } }),
  "/": () => new Response("<html></html>"),
};

/** Routes by pathname; captures the AbortSignal passed to each /products.json call so tests can assert it was actually aborted. */
function routedFetchCapturingSignals(routes: Record<string, (url: URL) => Response>) {
  const signals: AbortSignal[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.signal) signals.push(init.signal);
    const handler = routes[url.pathname];
    return handler ? handler(url) : new Response("not found", { status: 404 });
  });
  return { fetchImpl: fn as unknown as typeof fetch, signals };
}

describe("crawler response-size cap", () => {
  it("a normal response comfortably below the limit succeeds", async () => {
    const body = JSON.stringify({ products: [product(1), product(2)] });
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () => new Response(body, { headers: { "content-type": "application/json" } }),
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, maxResponseBytes: byteLength(body) + 1000 });

    expect(result.status).toBe("ok");
  });

  it("a response exactly at the limit succeeds — the boundary is inclusive", async () => {
    const body = JSON.stringify({ products: [product(1), product(2), product(3)] });
    const exact = byteLength(body);
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () => new Response(body, { headers: { "content-type": "application/json" } }),
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, maxResponseBytes: exact });

    expect(result.status).toBe("ok");
  });

  it("a response one byte over the limit is rejected without crashing, and never silently truncated into invalid JSON", async () => {
    const body = JSON.stringify({ products: [product(1), product(2), product(3)] });
    const oneOver = byteLength(body) - 1;
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () => new Response(body, { headers: { "content-type": "application/json" } }),
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, maxResponseBytes: oneOver });

    // Reuses the EXISTING classification system (classifyFirstPageFailure) —
    // a 200 status with an unusable body already has a defined, honest,
    // non-crashing outcome in this codebase (`not_found`), not a new one
    // invented for this feature.
    expect(["error", "not_found", "blocked"]).toContain(result.status);
    if (result.status === "error" || result.status === "not_found" || result.status === "blocked") {
      expect(result.reason).toMatch(/exceeded the \d+-byte limit/);
    }
  });

  it("a declared Content-Length above the limit is rejected WITHOUT reading the body at all (fast rejection)", async () => {
    const smallBody = JSON.stringify({ products: [product(1)] }); // actual body is tiny
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () =>
        new Response(smallBody, {
          headers: { "content-type": "application/json", "content-length": "99999999" }, // lies: declares ~100MB
        }),
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, maxResponseBytes: 1000 });

    expect(["error", "not_found", "blocked"]).toContain(result.status);
    if (result.status === "error" || result.status === "not_found" || result.status === "blocked") {
      expect(result.reason).toMatch(/declared content-length 99999999 exceeds/);
    }
  });

  it("a chunked/streamed response (no Content-Length header) exceeding the limit is still caught by the streaming byte-count", async () => {
    const maxBytes = 500;
    // A fresh stream per invocation — crawlShopifyStore retries a failed
    // first page once, and a ReadableStream can only ever be consumed once,
    // exactly like a real chunked HTTP response from a real server would be
    // re-requested (not replayed) on retry.
    function freshStream() {
      const chunk = new TextEncoder().encode("x".repeat(300));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          // Two 300-byte chunks (600 total) with NO content-length header —
          // exactly the shape of real chunked transfer encoding, where the
          // declared-length fast path never applies at all.
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
    }
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () => new Response(freshStream(), { headers: { "content-type": "application/json" } }),
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, maxResponseBytes: maxBytes });

    expect(["error", "not_found", "blocked"]).toContain(result.status);
    if (result.status === "error" || result.status === "not_found" || result.status === "blocked") {
      expect(result.reason).toMatch(/exceeded the 500-byte limit while streaming/);
    }
  });

  it("a malformed Content-Length header is ignored (falls through to the streaming check) rather than crashing", async () => {
    const body = JSON.stringify({ products: [product(1)] });
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () =>
        new Response(body, {
          headers: { "content-type": "application/json", "content-length": "not-a-number" },
        }),
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, maxResponseBytes: byteLength(body) + 1000 });

    expect(result.status).toBe("ok"); // small real body, malformed header doesn't block it
  });

  it("exceeding the limit actually aborts the underlying request (defense in depth, not just a logical 'give up')", async () => {
    const maxBytes = 200;
    function freshStream() {
      const chunk = new TextEncoder().encode("x".repeat(300));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
    }
    const { fetchImpl, signals } = routedFetchCapturingSignals({
      "/products.json": () => new Response(freshStream(), { headers: { "content-type": "application/json" } }),
      ...NOOP_EXTRAS,
    });

    await crawl("example.com", { fetchImpl, maxResponseBytes: maxBytes });

    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].aborted).toBe(true);
  });

  it("a realistically-sized real Shopify page (250 verbose products) still succeeds under the real 10 MB production default", async () => {
    const products = Array.from({ length: 250 }, (_, i) =>
      product(i, {
        title: `A Fairly Long Product Title For Product Number ${i} With Extra Descriptive Words`,
        tags: "tag1,tag2,tag3,tag4,tag5",
        variants: Array.from({ length: 4 }, (_, v) => ({
          id: i * 100 + v,
          title: `Variant ${v}`,
          sku: `SKU-${i}-${v}`,
          price: "29.99",
          compare_at_price: null,
          available: true,
          position: v,
        })),
      }),
    );
    const { fetchImpl } = routedFetchCapturingSignals({
      "/products.json": () => new Response(JSON.stringify({ products }), { headers: { "content-type": "application/json" } }),
      ...NOOP_EXTRAS,
    });

    // No maxResponseBytes override — exercises the real production default (10 MB).
    const result = await crawl("example.com", { fetchImpl, pageSize: 250 });

    expect(result.status).toBe("ok");
  });
});
