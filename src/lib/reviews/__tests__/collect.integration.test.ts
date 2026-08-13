import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collectStorefrontReviewObservations } from "../collect";
import type { DnsLookup } from "../../security/ssrf-guard";

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
    `TRUNCATE "StorefrontReviewObservation","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

const SAFE_DNS: DnsLookup = async () => [{ address: "8.8.8.8" }];

async function makeStore() {
  return prisma.store.create({ data: { domain: `collect-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

async function makeProduct(storeId: string, externalId: string, handle: string, bestsellerRank: number | null = null) {
  return prisma.product.create({
    data: { storeId, externalId, handle, title: handle, priceMinCents: 1000, priceMaxCents: 1000, bestsellerRank },
  });
}

async function makeCrawl(storeId: string) {
  return prisma.crawl.create({ data: { storeId, status: "OK" } });
}

function htmlWithCount(handle: string, count: number): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    url: `https://store.example.com/products/${handle}`,
    aggregateRating: { reviewCount: count },
  })}</script></head></html>`;
}

function jsonResponse(text: string, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(text) };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

describe("collectStorefrontReviewObservations — real Postgres", () => {
  it("31. persists a real observation row for a product with a usable count", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, "p1", "cool-shirt", 1);
    const crawl = await makeCrawl(store.id);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(htmlWithCount("cool-shirt", 218)));
    await collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsLookup: SAFE_DNS,
    });

    const rows = await prisma.storefrontReviewObservation.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewCount).toBe(218);
    expect(rows[0].crawlId).toBe(crawl.id);
    expect(rows[0].source).toBe("storefront_jsonld");
  });

  it("persists a null-reviewCount row (sampled, nothing found) — never coerced to 0, distinguishable from never-sampled", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, "p1", "plain-shirt", 1);
    const crawl = await makeCrawl(store.id);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("<html><body>no reviews here</body></html>"));
    await collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsLookup: SAFE_DNS,
    });

    const rows = await prisma.storefrontReviewObservation.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewCount).toBeNull();
  });

  it("writes NO row at all when the page fetch itself fails — a failure is not an observation", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, "p1", "blocked-shirt", 1);
    const crawl = await makeCrawl(store.id);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("forbidden", false, 403));
    await collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsLookup: SAFE_DNS,
    });

    const rows = await prisma.storefrontReviewObservation.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(0);
  });

  it("real idempotency: calling twice for the same crawl upserts, never duplicates", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id, "p1", "cool-shirt", 1);
    const crawl = await makeCrawl(store.id);

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(htmlWithCount("cool-shirt", 100)));
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: SAFE_DNS };
    await collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, opts);
    await collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, opts);

    const rows = await prisma.storefrontReviewObservation.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewCount).toBe(100);
  });

  it("real provider-aware budget: detected Okendo store samples more products than a store with none", async () => {
    const storeWithProvider = await makeStore();
    await prisma.storeEntity.create({
      data: { storeId: storeWithProvider.id, kind: "APP", key: "okendo", status: "ACTIVE" },
    });
    for (let i = 0; i < 8; i++) {
      await makeProduct(storeWithProvider.id, `p${i}`, `product-${i}`, i);
    }
    const crawlA = await makeCrawl(storeWithProvider.id);

    const storeNoProvider = await makeStore();
    for (let i = 0; i < 8; i++) {
      await makeProduct(storeNoProvider.id, `p${i}`, `product-${i}`, i);
    }
    const crawlB = await makeCrawl(storeNoProvider.id);

    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(htmlWithCount("product-0", 5))));
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: SAFE_DNS };

    await collectStorefrontReviewObservations(prisma, storeWithProvider.id, storeWithProvider.domain, crawlA.id, opts);
    const withProviderRows = await prisma.storefrontReviewObservation.count({ where: { crawlId: crawlA.id } });

    await collectStorefrontReviewObservations(prisma, storeNoProvider.id, storeNoProvider.domain, crawlB.id, opts);
    const noProviderRows = await prisma.storefrontReviewObservation.count({ where: { crawlId: crawlB.id } });

    // 8 real products exist for each store — well under the with-provider
    // budget (20), so that store samples all 8; the no-provider budget (5)
    // is smaller than 8, so that store is capped at exactly 5. This proves
    // BOTH the real cap AND that the provider is actually read from the
    // database end to end, not just unit-tested in isolation.
    expect(withProviderRows).toBe(8);
    expect(noProviderRows).toBe(5);
    const withProviderSample = await prisma.storefrontReviewObservation.findFirst({ where: { crawlId: crawlA.id } });
    expect(withProviderSample?.provider).toBe("okendo");
    const noProviderSample = await prisma.storefrontReviewObservation.findFirst({ where: { crawlId: crawlB.id } });
    expect(noProviderSample?.provider).toBeNull();
  });

  it("27. real shared-count detection persists sharedWithGroup across a real batch", async () => {
    const store = await makeStore();
    await makeProduct(store.id, "p1", "shirt-red", 1);
    await makeProduct(store.id, "p2", "shirt-blue", 2);
    await makeProduct(store.id, "p3", "shirt-green", 3);
    const crawl = await makeCrawl(store.id);

    const fetchImpl = vi.fn().mockImplementation((rawUrl: string) => {
      const url = String(rawUrl);
      if (url.includes("shirt-green")) return Promise.resolve(jsonResponse(htmlWithCount("shirt-green", 999)));
      // red and blue share the exact same count — simulating a real
      // product-group/variant-shared total (Milestone 9 Sub-phase D).
      const handle = url.includes("shirt-red") ? "shirt-red" : "shirt-blue";
      return Promise.resolve(jsonResponse(htmlWithCount(handle, 1626)));
    });
    await collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dnsLookup: SAFE_DNS,
    });

    const rows = await prisma.storefrontReviewObservation.findMany({
      where: { crawlId: crawl.id },
      include: { product: true },
    });
    const shared = rows.filter((r) => r.reviewCount === 1626);
    const notShared = rows.filter((r) => r.reviewCount === 999);
    expect(shared).toHaveLength(2);
    expect(shared.every((r) => r.sharedWithGroup)).toBe(true);
    expect(notShared).toHaveLength(1);
    expect(notShared[0].sharedWithGroup).toBe(false);
  });

  it("no candidates (zero products) is a safe no-op, never throws", async () => {
    const store = await makeStore();
    const crawl = await makeCrawl(store.id);
    await expect(
      collectStorefrontReviewObservations(prisma, store.id, store.domain, crawl.id, { dnsLookup: SAFE_DNS }),
    ).resolves.not.toThrow();
  });
});
