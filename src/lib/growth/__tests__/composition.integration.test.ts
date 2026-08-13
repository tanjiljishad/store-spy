import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCatalogComposition } from "../composition";

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
    `TRUNCATE "Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore() {
  return prisma.store.create({ data: { domain: `composition-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("getCatalogComposition — real Postgres", () => {
  it("returns UNAVAILABLE for a store with zero active products", async () => {
    const store = await makeStore();
    const result = await getCatalogComposition(prisma, store.id);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("only counts ACTIVE products, ignoring MISSING/REMOVED ones", async () => {
    const store = await makeStore();
    await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "active",
        handle: "active",
        title: "Active",
        priceMinCents: 1000,
        priceMaxCents: 1000,
        status: "ACTIVE",
        vendor: "Acme",
      },
    });
    await prisma.product.create({
      data: {
        storeId: store.id,
        externalId: "removed",
        handle: "removed",
        title: "Removed",
        priceMinCents: 9999,
        priceMaxCents: 9999,
        status: "REMOVED",
        vendor: "Ghost",
      },
    });

    const result = await getCatalogComposition(prisma, store.id);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.productCount).toBe(1);
    expect(result.vendorMix).toEqual([{ label: "Acme", count: 1 }]);
  });

  it("computes real vendor/type mix and discount depth from real Product rows", async () => {
    const store = await makeStore();
    await prisma.product.createMany({
      data: [
        {
          storeId: store.id,
          externalId: "p1",
          handle: "p1",
          title: "P1",
          priceMinCents: 2000,
          priceMaxCents: 2000,
          compareAtMaxCents: 4000,
          vendor: "Acme",
          productType: "Shoes",
          status: "ACTIVE",
        },
        {
          storeId: store.id,
          externalId: "p2",
          handle: "p2",
          title: "P2",
          priceMinCents: 3000,
          priceMaxCents: 3000,
          vendor: "Acme",
          productType: "Hats",
          status: "ACTIVE",
        },
      ],
    });

    const result = await getCatalogComposition(prisma, store.id);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.priceSpread.minCents).toBe(2000);
    expect(result.priceSpread.maxCents).toBe(3000);
    expect(result.discountDepth).toEqual({ discountedCount: 1, totalCount: 2, averageDiscountPercent: 50 });
    expect(result.vendorMix).toEqual([{ label: "Acme", count: 2 }]);
    expect(result.productTypeMix).toEqual(
      expect.arrayContaining([
        { label: "Shoes", count: 1 },
        { label: "Hats", count: 1 },
      ]),
    );
  });
});
