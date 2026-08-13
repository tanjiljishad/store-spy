import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getChangeFeed } from "../change-feed";
import { TECHNOLOGY_EVENT_TYPES } from "../event-categories";

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

async function makeStoreWithCrawl() {
  const store = await prisma.store.create({ data: { domain: `feed-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
  const crawl = await prisma.crawl.create({ data: { storeId: store.id, status: "OK" } });
  return { store, crawl };
}

async function makeEvent(
  storeId: string,
  crawlId: string,
  overrides: { eventType?: string; occurredAt?: Date; backfilled?: boolean; significance?: number } = {},
) {
  return prisma.event.create({
    data: {
      storeId,
      crawlId,
      entityType: "PRODUCT",
      entityKey: randomUUID(),
      eventType: (overrides.eventType ?? "PRODUCT_ADDED") as never,
      significance: overrides.significance ?? 50,
      headline: "Test event",
      backfilled: overrides.backfilled ?? false,
      dedupeKey: randomUUID(),
      occurredAt: overrides.occurredAt ?? new Date(),
    },
  });
}

describe("getChangeFeed", () => {
  it("returns events newest-first", async () => {
    const { store, crawl } = await makeStoreWithCrawl();
    const t0 = new Date("2026-08-01T00:00:00Z");
    await makeEvent(store.id, crawl.id, { occurredAt: new Date(t0.getTime()) });
    await makeEvent(store.id, crawl.id, { occurredAt: new Date(t0.getTime() + 2000) });
    await makeEvent(store.id, crawl.id, { occurredAt: new Date(t0.getTime() + 1000) });

    const page = await getChangeFeed(prisma, store.id, { limit: 10 });

    const times = page.items.map((i) => new Date(i.occurredAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("excludes backfilled events — those power history, not the 'what just happened' feed", async () => {
    const { store, crawl } = await makeStoreWithCrawl();
    await makeEvent(store.id, crawl.id, { backfilled: true });
    await makeEvent(store.id, crawl.id, { backfilled: false });

    const page = await getChangeFeed(prisma, store.id, { limit: 10 });

    expect(page.items).toHaveLength(1);
  });

  it("paginates via cursor without gaps or duplicates", async () => {
    const { store, crawl } = await makeStoreWithCrawl();
    const base = new Date("2026-08-01T00:00:00Z").getTime();
    for (let i = 0; i < 25; i++) {
      await makeEvent(store.id, crawl.id, { occurredAt: new Date(base + i * 1000) });
    }

    const seen = new Set<string>();
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    do {
      const page = await getChangeFeed(prisma, store.id, { limit: 10, cursor });
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false); // no duplicates across pages
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen.size).toBe(25);
    expect(pages).toBe(3); // 10 + 10 + 5
  });

  it("filters by event type when requested", async () => {
    const { store, crawl } = await makeStoreWithCrawl();
    await makeEvent(store.id, crawl.id, { eventType: "PRODUCT_ADDED" });
    await makeEvent(store.id, crawl.id, { eventType: "PRICE_DROP" });

    const page = await getChangeFeed(prisma, store.id, { eventTypes: ["PRICE_DROP"] });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].eventType).toBe("PRICE_DROP");
  });

  it("returns an empty page (not an error) for a store with no events yet", async () => {
    const { store } = await makeStoreWithCrawl();
    const page = await getChangeFeed(prisma, store.id, {});
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("TECHNOLOGY_EVENT_TYPES filters real technology events and excludes real product/marketing events (Milestone 7 Sub-phase C Technology stack section)", async () => {
    const { store, crawl } = await makeStoreWithCrawl();
    // One real event per technology category value, proving every literal
    // in the constant is a real, correctly-spelled EventType the database
    // actually accepts — a typo here would fail this insert, not just a
    // type-level check.
    for (const eventType of TECHNOLOGY_EVENT_TYPES) {
      await makeEvent(store.id, crawl.id, { eventType });
    }
    // Real events from other categories that must NOT leak into the filter.
    await makeEvent(store.id, crawl.id, { eventType: "PRODUCT_ADDED" });
    await makeEvent(store.id, crawl.id, { eventType: "AD_DETECTED" });
    await makeEvent(store.id, crawl.id, { eventType: "BESTSELLER_CLIMBED" });

    const page = await getChangeFeed(prisma, store.id, { eventTypes: [...TECHNOLOGY_EVENT_TYPES], limit: 50 });

    expect(page.items).toHaveLength(TECHNOLOGY_EVENT_TYPES.length);
    const returnedTypes = new Set(page.items.map((i) => i.eventType));
    for (const eventType of TECHNOLOGY_EVENT_TYPES) {
      expect(returnedTypes.has(eventType)).toBe(true);
    }
    expect(returnedTypes.has("PRODUCT_ADDED")).toBe(false);
    expect(returnedTypes.has("AD_DETECTED")).toBe(false);
    expect(returnedTypes.has("BESTSELLER_CLIMBED")).toBe(false);
  });
});
