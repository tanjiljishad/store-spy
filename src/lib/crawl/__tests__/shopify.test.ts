import { describe, expect, it, vi } from "vitest";
import { canonicalizeDomain, crawlShopifyStore, probeShopifyStorePage1, type CrawlOptions } from "../shopify";
import type { ShopifyProduct } from "../normalize";
import type { DnsLookup } from "../../security/ssrf-guard";

// example.com resolves to a real public address, but doing a real DNS lookup
// on every test would make this suite slow and network-dependent for no
// reason — the SSRF guard itself is unit-tested in security/ssrf-guard.test.ts.
// This stands in for "yes, this domain is safe to crawl" without the network.
const SAFE_DNS: DnsLookup = async () => [{ address: "8.8.8.8" }];
function crawl(domain: string, opts: CrawlOptions = {}) {
  return crawlShopifyStore(domain, { dnsLookup: SAFE_DNS, ...opts });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
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

/** Routes by pathname; each handler advances its own call count independently. */
function routedFetch(routes: Record<string, (url: URL, callIndex: number) => Response | Promise<Response>>) {
  const counts: Record<string, number> = {};
  const fn = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const handler = routes[url.pathname];
    if (!handler) return textResponse("not found", 404);
    counts[url.pathname] = (counts[url.pathname] ?? 0) + 1;
    return handler(url, counts[url.pathname]);
  });
  return fn as unknown as typeof fetch;
}

const NOOP_EXTRAS = {
  "/collections/all/products.json": () => jsonResponse({ products: [] }),
  "/collections.json": () => jsonResponse({ collections: [] }),
  "/": () => textResponse("<html></html>"),
};

describe("canonicalizeDomain", () => {
  it("strips protocol, www, and trailing path", () => {
    expect(canonicalizeDomain("https://www.Example.com/some/path")).toBe("example.com");
    expect(canonicalizeDomain("Example.com")).toBe("example.com");
  });
});

describe("crawlShopifyStore — happy paths", () => {
  it("a single short page is one clean crawl", async () => {
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        expect(url.searchParams.get("page")).toBe("1");
        return jsonResponse({ products: [product(1), product(2)] });
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, pageSize: 5, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1, 2]);
    expect(result.input.pagesFetched).toBe(1);
    expect(result.input.httpErrors).toBe(0);
  });

  it("paginates across multiple full pages until a short page ends it", async () => {
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ products: [product(1), product(2)] });
        if (page === 2) return jsonResponse({ products: [product(3), product(4)] });
        if (page === 3) return jsonResponse({ products: [product(5)] }); // short -> end
        return jsonResponse({ products: [] });
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, pageSize: 2, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect(result.input.pagesFetched).toBe(3);
    expect(result.input.httpErrors).toBe(0);
  });

  it("terminates cleanly on an explicit empty page", async () => {
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ products: [product(1), product(2)] });
        return jsonResponse({ products: [] }); // full-size page 1, then empty
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, pageSize: 2, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1, 2]);
    expect(result.input.httpErrors).toBe(0);
  });
});

describe("crawlShopifyStore — the repeat-page quirk", () => {
  it("treats a repeated page as end-of-catalog, not a failure", async () => {
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ products: [product(1), product(2)] });
        // Shopify quirk: page 2+ silently repeats page 1 instead of []
        return jsonResponse({ products: [product(1), product(2)] });
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, pageSize: 2, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1, 2]); // not duplicated
    expect(result.input.httpErrors).toBe(0); // clean signal, not a failure
  });
});

describe("crawlShopifyStore — mid-crawl failures", () => {
  it("a later page failing (after retry) sets httpErrors and stops, but keeps status ok", async () => {
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ products: [product(1), product(2)] });
        return jsonResponse({ error: "boom" }, 500); // every attempt at page 2 fails
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, pageSize: 2, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1, 2]);
    expect(result.input.httpErrors).toBe(1);
    expect(result.input.pagesFetched).toBe(1);
  });

  it("recovers from a single transient blip via the one retry", async () => {
    let page2Attempts = 0;
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ products: [product(1), product(2)] });
        page2Attempts++;
        if (page2Attempts === 1) return jsonResponse({ error: "flaky" }, 503);
        return jsonResponse({ products: [product(3)] }); // short page -> end
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, pageSize: 2, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(result.input.httpErrors).toBe(0); // recovered, so never counted
  });

  it("recovers from a transient blip on page 1 too — found live against a real server, not hypothetical", async () => {
    let page1Attempts = 0;
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        expect(Number(url.searchParams.get("page"))).toBe(1);
        page1Attempts++;
        if (page1Attempts === 1) throw new Error("fetch failed"); // undici's real error shape for a network blip
        return jsonResponse({ products: [product(1)] });
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts.map((p) => p.id)).toEqual([1]);
    expect(page1Attempts).toBe(2);
  });

  it("hitting the safety cap without a clean end sets httpErrors (removal detection stays suppressed)", async () => {
    const fetchImpl = routedFetch({
      "/products.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        // Always returns a full page — never terminates on its own.
        return jsonResponse({ products: [product(page * 10), product(page * 10 + 1)] });
      },
      ...NOOP_EXTRAS,
    });

    const result = await crawl("example.com", {
      fetchImpl,
      pageSize: 2,
      maxPages: 3,
      requestDelayMs: 0,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.pagesFetched).toBe(3);
    expect(result.input.httpErrors).toBe(1);
  });
});

describe("crawlShopifyStore — first-page hard failures", () => {
  it("401 on the first page is classified as blocked", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => textResponse("unauthorized", 401) });
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).toBe("blocked");
  });

  it("403 on the first page is classified as blocked", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => textResponse("forbidden", 403) });
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).toBe("blocked");
  });

  it("404 on the first page is classified as not_found", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => textResponse("nope", 404) });
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).toBe("not_found");
  });

  it("a 200 with no products array (non-Shopify domain) is not_found", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => jsonResponse({ hello: "world" }) });
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).toBe("not_found");
  });

  it("a 200 bot-challenge page (Cloudflare) is classified as blocked, not not_found", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => textResponse("<html>Just a moment...<div class=cf-browser-verification></div></html>", 200),
    });
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).toBe("blocked");
  });

  it("a network failure on the first page is classified as error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND example.com");
    }) as unknown as typeof fetch;
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).toBe("error");
  });

  it("never returns status ok on a first-page failure — no fabricated empty snapshot", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => textResponse("nope", 404) });
    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });
    expect(result.status).not.toBe("ok");
  });
});

describe("crawlShopifyStore — extras never fail the crawl", () => {
  it("a broken bestsellers/collections/homepage still yields a usable snapshot", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1)] }),
      "/collections/all/products.json": () => textResponse("error", 500),
      "/collections.json": () => textResponse("error", 500),
      "/": () => textResponse("error", 500),
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.rawProducts).toHaveLength(1);
    expect(result.input.bestsellerRanks?.size).toBe(0);
    expect(result.input.collectionHandles).toEqual([]);
    expect(result.input.hasCollectionData).toBe(false);
    expect(result.input.tech).toBeNull();
    expect(result.input.hasTechData).toBe(false);
    expect(result.input.httpErrors).toBe(0); // extras failing must not touch this
  });

  it("wires bestseller ranks, collection handles, and tech through when available", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1), product(2)] }),
      "/collections/all/products.json": () => jsonResponse({ products: [product(2), product(1)] }), // #2 outsells #1
      "/collections.json": () => jsonResponse({ collections: [{ handle: "all" }, { handle: "sale" }] }),
      "/": () =>
        textResponse(
          `<html><script>Shopify.theme = {"name":"Dawn","id":1};Shopify.currency = {"active":"USD"};fbq('init','123456789');</script></html>`,
        ),
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.bestsellerRanks?.get("2")).toBe(0);
    expect(result.input.bestsellerRanks?.get("1")).toBe(1);
    expect(result.input.collectionHandles).toEqual(["all", "sale"]);
    expect(result.input.hasCollectionData).toBe(true);
    expect(result.input.tech?.themeName).toBe("Dawn");
    expect(result.input.tech?.pixels.facebook).toBe("123456789");
    expect(result.input.hasTechData).toBe(true);
    expect(result.input.currency).toBe("USD");
  });
});

describe("crawlShopifyStore — /collections.json pagination", () => {
  it("paginates past 250 collections (confirmed against a real store: allbirds has 1,345)", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1)] }),
      "/collections.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) {
          return jsonResponse({ collections: Array.from({ length: 250 }, (_, i) => ({ handle: `c${i}` })) });
        }
        if (page === 2) {
          return jsonResponse({ collections: Array.from({ length: 95 }, (_, i) => ({ handle: `c${250 + i}` })) });
        }
        return jsonResponse({ collections: [] });
      },
      "/collections/all/products.json": () => jsonResponse({ products: [] }),
      "/": () => textResponse("<html></html>"),
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.collectionHandles).toHaveLength(345);
    expect(result.input.collectionHandles).toContain("c0");
    expect(result.input.collectionHandles).toContain("c344");
    expect(result.input.hasCollectionData).toBe(true);
  });

  it("treats the same repeat-page quirk as products.json — clean end, not a failure", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1)] }),
      "/collections.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ collections: Array.from({ length: 250 }, (_, i) => ({ handle: `c${i}` })) });
        // repeats page 1 instead of returning empty
        return jsonResponse({ collections: Array.from({ length: 250 }, (_, i) => ({ handle: `c${i}` })) });
      },
      "/collections/all/products.json": () => jsonResponse({ products: [] }),
      "/": () => textResponse("<html></html>"),
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.collectionHandles).toHaveLength(250); // not duplicated
    expect(result.input.hasCollectionData).toBe(true);
  });

  it("a mid-pagination failure marks hasCollectionData false rather than silently truncating", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1)] }),
      "/collections.json": (url) => {
        const page = Number(url.searchParams.get("page"));
        if (page === 1) return jsonResponse({ collections: Array.from({ length: 250 }, (_, i) => ({ handle: `c${i}` })) });
        return textResponse("error", 500);
      },
      "/collections/all/products.json": () => jsonResponse({ products: [] }),
      "/": () => textResponse("<html></html>"),
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    expect(result.status).toBe("ok"); // this is a best-effort extra, never fails the crawl
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.input.collectionHandles).toHaveLength(250); // what we got is real, just incomplete
    expect(result.input.hasCollectionData).toBe(false); // so removal detection stays suppressed for collections
  });
});

describe("crawlShopifyStore — progress events", () => {
  it("emits real phase transitions carrying real data, in order", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1), product(2)] }),
      "/collections/all/products.json": () => jsonResponse({ products: [product(1)] }),
      "/collections.json": () => jsonResponse({ collections: [{ handle: "all" }] }),
      "/": () => textResponse(`<script>Shopify.theme = {"name":"Dawn"};</script>`),
    });

    const events: Array<{ phase: string; message: string }> = [];
    const result = await crawl("example.com", {
      fetchImpl,
      requestDelayMs: 0,
      onProgress: (e) => events.push({ phase: e.phase, message: e.message }),
    });

    expect(result.status).toBe("ok");
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe("validating");
    expect(phases).toContain("connecting");
    expect(phases).toContain("fetching_products");
    expect(phases).toContain("fetching_extras");
    expect(phases[phases.length - 1]).toBe("done");

    // Not synthetic — the actual discovered count and theme name appear.
    expect(events.some((e) => e.message.includes("2 products"))).toBe(true);
    expect(events.some((e) => e.message.includes("Dawn"))).toBe(true);
  });

  it("never emits a progress event on SSRF rejection — nothing ran to report on", async () => {
    const events: unknown[] = [];
    await crawlShopifyStore("internal.com", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      dnsLookup: async () => [{ address: "10.0.0.1" }],
      onProgress: (e) => events.push(e),
    });
    // "validating" is the one event that legitimately fires before rejection.
    expect(events).toHaveLength(1);
  });
});

describe("crawlShopifyStore — SSRF protection", () => {
  it("rejects a domain that resolves to a private address before making any request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should never be called — the SSRF guard must reject before any fetch");
    }) as unknown as typeof fetch;
    const privateDns: DnsLookup = async () => [{ address: "10.0.0.5" }];

    const result = await crawlShopifyStore("internal-target.com", {
      fetchImpl,
      dnsLookup: privateDns,
      requestDelayMs: 0,
    });

    expect(result.status).toBe("invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a domain resolving to the cloud metadata address", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const metadataDns: DnsLookup = async () => [{ address: "169.254.169.254" }];

    const result = await crawlShopifyStore("looks-legit.com", {
      fetchImpl,
      dnsLookup: metadataDns,
      requestDelayMs: 0,
    });

    expect(result.status).toBe("invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a redirect to a private IP literal mid-crawl, even though the domain itself was safe", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
    });

    const result = await crawl("example.com", { fetchImpl, requestDelayMs: 0 });

    // The redirect target is a private IP literal — no DNS lookup needed to
    // catch it, so this proves per-hop revalidation runs even with SAFE_DNS
    // configured for the *original* host.
    expect(result.status).toBe("error");
  });
});

describe("probeShopifyStorePage1 — Milestone 12 §1.3's anonymous shallow probe", () => {
  function probe(domain: string, opts: CrawlOptions = {}) {
    return probeShopifyStorePage1(domain, { dnsLookup: SAFE_DNS, ...opts });
  }

  it("makes exactly one request, to products.json page 1 — never the extras crawlShopifyStore fetches", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => jsonResponse({ products: [product(1), product(2)] }),
    });

    const result = await probe("real-store.com", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(String(calledUrl)).toContain("/products.json");
    expect(String(calledUrl)).toContain("page=1");
    expect(result).toMatchObject({ status: "ok", productCount: 2 });
  });

  it("computes the real price range from the page's own variants", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () =>
        jsonResponse({
          products: [
            product(1, { variants: [{ id: 10, title: "Default", sku: null, price: "19.99", compare_at_price: null, available: true, position: 1 }] }),
            product(2, { variants: [{ id: 20, title: "Default", sku: null, price: "89.00", compare_at_price: null, available: true, position: 1 }] }),
          ],
        }),
    });

    const result = await probe("priced-store.com", { fetchImpl });
    expect(result).toMatchObject({ status: "ok", priceMinCents: 1999, priceMaxCents: 8900 });
  });

  it("does not retry on a transient failure — the caller (anonymous-probe.ts) deliberately wants at most one fetch even on error", async () => {
    const fetchImpl = routedFetch({
      "/products.json": () => textResponse("server error", 500),
    });

    const result = await probe("flaky-store.com", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry, unlike crawlShopifyStore's own page-1 probe
    expect(result.status).toBe("error");
  });

  it("classifies a 404 as not_found, reusing the same classification crawlShopifyStore uses", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => textResponse("nope", 404) });
    const result = await probe("not-shopify.com", { fetchImpl });
    expect(result.status).toBe("not_found");
  });

  it("rejects an SSRF-unsafe target without making any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await probeShopifyStorePage1("internal-target.com", {
      fetchImpl,
      dnsLookup: async () => [{ address: "169.254.169.254" }],
    });
    expect(result.status).toBe("invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a page with zero products is still status: ok, with productCount 0 and a null price range", async () => {
    const fetchImpl = routedFetch({ "/products.json": () => jsonResponse({ products: [] }) });
    const result = await probe("empty-store.com", { fetchImpl });
    expect(result).toMatchObject({ status: "ok", productCount: 0, priceMinCents: null, priceMaxCents: null });
  });
});
