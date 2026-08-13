import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getReviewObservationSignal, getReviewCoverageSummary } from "../signal";

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

async function makeStore() {
  return prisma.store.create({ data: { domain: `signal-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

async function makeProduct(storeId: string) {
  return prisma.product.create({
    data: { storeId, externalId: "p1", handle: "cool-shirt", title: "Cool Shirt", priceMinCents: 1000, priceMaxCents: 1000 },
  });
}

async function makeCrawl(storeId: string, startedAt: Date) {
  return prisma.crawl.create({ data: { storeId, status: "OK", startedAt } });
}

describe("getReviewObservationSignal — real Postgres", () => {
  it("NOT_SAMPLED for a real product with zero observation rows", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id);
    const result = await getReviewObservationSignal(prisma, product.id);
    expect(result).toEqual({ status: "NOT_SAMPLED" });
  });

  it("22/23. OBSERVED with a real increase across two real crawls", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id);
    const crawl1 = await makeCrawl(store.id, new Date("2026-08-01T00:00:00Z"));
    const crawl2 = await makeCrawl(store.id, new Date("2026-08-10T00:00:00Z"));

    await prisma.storefrontReviewObservation.create({
      data: { productId: product.id, crawlId: crawl1.id, reviewCount: 218, observedAt: new Date("2026-08-01T00:00:00Z") },
    });
    await prisma.storefrontReviewObservation.create({
      data: { productId: product.id, crawlId: crawl2.id, reviewCount: 231, observedAt: new Date("2026-08-10T00:00:00Z") },
    });

    const result = await getReviewObservationSignal(prisma, product.id);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.reviewCount).toBe(231);
    expect(result.change).toEqual({ previousCount: 218, delta: 13 });
  });

  it("29. UNSUPPORTED when the most recent real row has a null count", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id);
    const crawl = await makeCrawl(store.id, new Date("2026-08-01T00:00:00Z"));
    await prisma.storefrontReviewObservation.create({
      data: { productId: product.id, crawlId: crawl.id, reviewCount: null, observedAt: new Date("2026-08-01T00:00:00Z") },
    });

    const result = await getReviewObservationSignal(prisma, product.id);
    expect(result).toEqual({ status: "UNSUPPORTED" });
  });

  it("25/26. a real single first-ever row is OBSERVED with no fabricated baseline", async () => {
    const store = await makeStore();
    const product = await makeProduct(store.id);
    const crawl = await makeCrawl(store.id, new Date("2026-08-01T00:00:00Z"));
    await prisma.storefrontReviewObservation.create({
      data: { productId: product.id, crawlId: crawl.id, reviewCount: 5, observedAt: new Date("2026-08-01T00:00:00Z") },
    });

    const result = await getReviewObservationSignal(prisma, product.id);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.change).toBeNull();
  });
});

describe("getReviewCoverageSummary — real Postgres", () => {
  it("NOT_SAMPLED when the store has never had a successful crawl", async () => {
    const store = await makeStore();
    const result = await getReviewCoverageSummary(prisma, store.id);
    expect(result).toEqual({ status: "NOT_SAMPLED" });
  });

  it("NOT_SAMPLED when the latest crawl has zero review rows (review collection wasn't reached / found no candidates)", async () => {
    const store = await makeStore();
    await makeCrawl(store.id, new Date("2026-08-01T00:00:00Z"));
    const result = await getReviewCoverageSummary(prisma, store.id);
    expect(result).toEqual({ status: "NOT_SAMPLED" });
  });

  it("OBSERVED with real sampled/observed counts from the most recent crawl only", async () => {
    const store = await makeStore();
    const p1 = await prisma.product.create({
      data: { storeId: store.id, externalId: "p1", handle: "a", title: "A", priceMinCents: 1, priceMaxCents: 1 },
    });
    const p2 = await prisma.product.create({
      data: { storeId: store.id, externalId: "p2", handle: "b", title: "B", priceMinCents: 1, priceMaxCents: 1 },
    });
    const oldCrawl = await makeCrawl(store.id, new Date("2026-08-01T00:00:00Z"));
    const latestCrawl = await makeCrawl(store.id, new Date("2026-08-10T00:00:00Z"));

    // An older crawl's rows must never leak into the latest-crawl coverage count.
    await prisma.storefrontReviewObservation.create({
      data: { productId: p1.id, crawlId: oldCrawl.id, reviewCount: 999 },
    });
    await prisma.storefrontReviewObservation.create({
      data: { productId: p1.id, crawlId: latestCrawl.id, reviewCount: 10 },
    });
    await prisma.storefrontReviewObservation.create({
      data: { productId: p2.id, crawlId: latestCrawl.id, reviewCount: null },
    });

    const result = await getReviewCoverageSummary(prisma, store.id);
    expect(result).toEqual({ status: "OBSERVED", sampledCount: 2, observedCount: 1 });
  });

  it("UNSUPPORTED when the latest crawl sampled products but found nothing usable", async () => {
    const store = await makeStore();
    const p1 = await prisma.product.create({
      data: { storeId: store.id, externalId: "p1", handle: "a", title: "A", priceMinCents: 1, priceMaxCents: 1 },
    });
    const crawl = await makeCrawl(store.id, new Date("2026-08-01T00:00:00Z"));
    await prisma.storefrontReviewObservation.create({ data: { productId: p1.id, crawlId: crawl.id, reviewCount: null } });

    const result = await getReviewCoverageSummary(prisma, store.id);
    expect(result).toEqual({ status: "UNSUPPORTED", sampledCount: 1 });
  });
});
