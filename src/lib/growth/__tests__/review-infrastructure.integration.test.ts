import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getReviewInfrastructureSignal } from "../review-infrastructure";

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
  await prisma.$executeRawUnsafe(`TRUNCATE "StoreEntity","Store" RESTART IDENTITY CASCADE`);
});

async function makeStore(baselinedAt: Date | null) {
  return prisma.store.create({ data: { domain: `review-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY", baselinedAt } });
}

describe("getReviewInfrastructureSignal — real Postgres", () => {
  it("a store checked with no review apps returns OBSERVED [] — checked, found nothing, never UNAVAILABLE", async () => {
    const store = await makeStore(new Date());
    await prisma.storeEntity.create({
      data: { storeId: store.id, kind: "APP", key: "klaviyo", status: "ACTIVE" }, // a real app, but not a review app
    });

    const result = await getReviewInfrastructureSignal(prisma, store.id, store.baselinedAt);
    expect(result).toEqual({ status: "OBSERVED", value: [] });
  });

  it("returns only the review-app subset from real StoreEntity rows, with real first/last seen", async () => {
    const store = await makeStore(new Date());
    const firstSeenAt = new Date("2026-03-14");
    const lastSeenAt = new Date("2026-08-01");
    await prisma.storeEntity.create({
      data: { storeId: store.id, kind: "APP", key: "judgeme", status: "ACTIVE", firstSeenAt, lastSeenAt },
    });
    await prisma.storeEntity.create({ data: { storeId: store.id, kind: "APP", key: "klaviyo", status: "ACTIVE" } });
    await prisma.storeEntity.create({ data: { storeId: store.id, kind: "PIXEL", key: "facebook", status: "ACTIVE" } });

    const result = await getReviewInfrastructureSignal(prisma, store.id, store.baselinedAt);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.value).toHaveLength(1);
    expect(result.value[0].key).toBe("judgeme");
    expect(result.value[0].firstSeenAt.getTime()).toBe(firstSeenAt.getTime());
  });

  it("a store never baselined returns UNAVAILABLE without touching StoreEntity at all", async () => {
    const store = await makeStore(null);
    await prisma.storeEntity.create({ data: { storeId: store.id, kind: "APP", key: "judgeme", status: "ACTIVE" } });

    const result = await getReviewInfrastructureSignal(prisma, store.id, store.baselinedAt);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "This store has not completed an initial crawl yet." });
  });

  it("reflects a removed review app's real status, not just its existence", async () => {
    const store = await makeStore(new Date());
    await prisma.storeEntity.create({
      data: { storeId: store.id, kind: "APP", key: "loox", status: "REMOVED", missingSince: new Date("2026-06-01") },
    });

    const result = await getReviewInfrastructureSignal(prisma, store.id, store.baselinedAt);
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.value[0].status).toBe("REMOVED");
  });
});
