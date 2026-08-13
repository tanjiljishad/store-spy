import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { STALE_CRAWL_THRESHOLD_MS, sweepStaleCrawls } from "../stale-crawl-sweep";

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
  return prisma.store.create({ data: { domain: `sweep-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
async function makeRunningCrawl(storeId: string, startedAt: Date, trigger: "MANUAL" | "SCHEDULED" = "SCHEDULED") {
  return prisma.crawl.create({ data: { storeId, status: "RUNNING", startedAt, trigger } });
}

const NOW = new Date("2026-08-13T12:00:00Z");

describe("sweepStaleCrawls — real Postgres", () => {
  it("recovers a genuinely stale RUNNING crawl to FAILED with an explanatory errorMessage", async () => {
    const store = await makeStore();
    const stale = await makeRunningCrawl(store.id, new Date(NOW.getTime() - STALE_CRAWL_THRESHOLD_MS - 60_000));

    const result = await sweepStaleCrawls(prisma, NOW);

    expect(result.recovered).toBe(1);
    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.status).toBe("FAILED");
    expect(row.finishedAt?.getTime()).toBe(NOW.getTime());
    expect(row.errorMessage).toMatch(/stale-crawl sweep/i);
    expect(row.errorMessage).toMatch(/30 minutes/);
  });

  it("leaves a fresh RUNNING crawl untouched — must never race a crawl that's simply still running", async () => {
    const store = await makeStore();
    const fresh = await makeRunningCrawl(store.id, new Date(NOW.getTime() - 2 * 60_000));

    const result = await sweepStaleCrawls(prisma, NOW);

    expect(result.recovered).toBe(0);
    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(row.status).toBe("RUNNING");
    expect(row.finishedAt).toBeNull();
  });

  it("leaves a crawl exactly at the threshold boundary untouched (strictly-older-than, not at-or-older-than)", async () => {
    const store = await makeStore();
    const atBoundary = await makeRunningCrawl(store.id, new Date(NOW.getTime() - STALE_CRAWL_THRESHOLD_MS));

    await sweepStaleCrawls(prisma, NOW);

    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: atBoundary.id } });
    expect(row.status).toBe("RUNNING");
  });

  it("is idempotent — a second sweep immediately after the first finds nothing left to recover", async () => {
    const store = await makeStore();
    await makeRunningCrawl(store.id, new Date(NOW.getTime() - 60 * 60_000));

    const first = await sweepStaleCrawls(prisma, NOW);
    const second = await sweepStaleCrawls(prisma, NOW);

    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
  });

  it("is safe under concurrent execution — two overlapping sweeps never double-count or crash", async () => {
    const store = await makeStore();
    const crawls = await Promise.all(
      Array.from({ length: 5 }, (_, i) => makeRunningCrawl(store.id, new Date(NOW.getTime() - (60 + i) * 60_000))),
    );

    const [a, b] = await Promise.all([sweepStaleCrawls(prisma, NOW), sweepStaleCrawls(prisma, NOW)]);

    // Together the two concurrent sweeps must recover each stale row exactly
    // once in total — never twice (no double-processing), never fewer than
    // the real count (no lost updates).
    expect(a.recovered + b.recovered).toBe(crawls.length);

    const rows = await prisma.crawl.findMany({ where: { storeId: store.id } });
    expect(rows.every((r) => r.status === "FAILED")).toBe(true);
  });

  it("never touches an unrelated completed crawl, regardless of age", async () => {
    const store = await makeStore();
    const old = await prisma.crawl.create({
      data: {
        storeId: store.id,
        status: "OK",
        startedAt: new Date(NOW.getTime() - 5 * 60 * 60_000),
        finishedAt: new Date(NOW.getTime() - 5 * 60 * 60_000 + 5000),
      },
    });

    await sweepStaleCrawls(prisma, NOW);

    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.status).toBe("OK");
  });

  it("recovers a stale MANUAL crawl exactly the same as a stale SCHEDULED one — the sweep doesn't discriminate by trigger", async () => {
    const store = await makeStore();
    const manual = await makeRunningCrawl(store.id, new Date(NOW.getTime() - 60 * 60_000), "MANUAL");

    const result = await sweepStaleCrawls(prisma, NOW);

    expect(result.recovered).toBe(1);
    const row = await prisma.crawl.findUniqueOrThrow({ where: { id: manual.id } });
    expect(row.status).toBe("FAILED");
  });
});

describe("sweepStaleCrawls — stays correct under a non-UTC session timezone (Asia/Kathmandu, UTC+5:45)", () => {
  const separator = url!.includes("?") ? "&" : "?";
  const tzPrisma = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });

  afterAll(async () => {
    await tzPrisma.$disconnect();
  });

  beforeEach(async () => {
    await tzPrisma.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kathmandu'`);
  });

  it("still recovers a genuinely stale crawl and still spares a fresh one — no raw SQL here, but proven anyway per project convention", async () => {
    const store = await tzPrisma.store.create({ data: { domain: `sweep-tz-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
    const stale = await tzPrisma.crawl.create({
      data: { storeId: store.id, status: "RUNNING", startedAt: new Date(NOW.getTime() - 60 * 60_000) },
    });
    const fresh = await tzPrisma.crawl.create({
      data: { storeId: store.id, status: "RUNNING", startedAt: new Date(NOW.getTime() - 60_000) },
    });

    const result = await sweepStaleCrawls(tzPrisma, NOW);

    expect(result.recovered).toBe(1);
    expect((await tzPrisma.crawl.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("FAILED");
    expect((await tzPrisma.crawl.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("RUNNING");
  });
});
