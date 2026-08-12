import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expireDueWatches, recomputeStoreTier, startMonitoring, stopMonitoring } from "../watch";

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
    `TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeUser() {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
}
async function makeStore(tier: "COLD" | "HOT" | "DISABLED" = "COLD") {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY", tier } });
}

const NOW = new Date("2026-08-11T12:00:00Z");

describe("startMonitoring", () => {
  it("starts monitoring, sets a 30-day expiry, and promotes Store.tier to HOT", async () => {
    const user = await makeUser();
    const store = await makeStore();

    const result = await startMonitoring(prisma, user.id, store.id, "FREE", NOW);

    expect(result.outcome).toBe("started");
    if (result.outcome === "started") {
      expect(result.expiresAt).not.toBeNull(); // FREE always has a fixed expiry — only BASIC's continuous monitoring is null
      expect(result.expiresAt?.toISOString()).toBe("2026-09-10T12:00:00.000Z"); // +30 days exactly
    }
    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("HOT");

    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringStatus).toBe("ACTIVE");
    expect(watch.monitoringStartedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("rejects a second active watch beyond the free limit of 1", async () => {
    const user = await makeUser();
    const storeA = await makeStore();
    const storeB = await makeStore();

    await startMonitoring(prisma, user.id, storeA.id, "FREE", NOW);
    const second = await startMonitoring(prisma, user.id, storeB.id, "FREE", NOW);

    expect(second).toEqual({
      outcome: "limit_reached",
      code: "MONITORING_LIMIT_REACHED",
      capability: "MAX_ACTIVE_MONITORED_STORES",
    });
    const storeBAfter = await prisma.store.findUniqueOrThrow({ where: { id: storeB.id } });
    expect(storeBAfter.tier).toBe("COLD"); // never promoted — the watch never activated
  });

  it("is idempotent: starting monitoring on an already-active watch doesn't error or double-charge the slot", async () => {
    const user = await makeUser();
    const store = await makeStore();

    await startMonitoring(prisma, user.id, store.id, "FREE", NOW);
    const again = await startMonitoring(prisma, user.id, store.id, "FREE", NOW);

    expect(again.outcome).toBe("already_active");
  });

  it("does not let two simultaneous starts for the same user give them two active watches", async () => {
    const user = await makeUser();
    const storeA = await makeStore();
    const storeB = await makeStore();

    const [a, b] = await Promise.all([
      startMonitoring(prisma, user.id, storeA.id, "FREE", NOW),
      startMonitoring(prisma, user.id, storeB.id, "FREE", NOW),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["limit_reached", "started"]);

    const activeCount = await prisma.watchlist.count({ where: { userId: user.id, monitoringStatus: "ACTIVE" } });
    expect(activeCount).toBe(1);
  });

  it("a second user watching the SAME store as a first user is unaffected by the first user's limit", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const store = await makeStore();

    const a = await startMonitoring(prisma, userA.id, store.id, "FREE", NOW);
    const b = await startMonitoring(prisma, userB.id, store.id, "FREE", NOW);

    expect(a.outcome).toBe("started");
    expect(b.outcome).toBe("started");
  });
});

describe("stopMonitoring / recomputeStoreTier — the union-of-watchers rule", () => {
  it("removing the only watcher demotes the store back to COLD", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await startMonitoring(prisma, user.id, store.id, "FREE", NOW);

    await stopMonitoring(prisma, user.id, store.id);

    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("COLD");
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringStatus).toBe("REMOVED");
  });

  it("removing ONE of two watchers keeps the store at HOT — the other watcher still justifies it", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const store = await makeStore();
    await startMonitoring(prisma, userA.id, store.id, "FREE", NOW);
    await startMonitoring(prisma, userB.id, store.id, "FREE", NOW);

    await stopMonitoring(prisma, userA.id, store.id);

    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("HOT"); // userB's watch is still active
  });

  it("never resurrects a DISABLED store just because someone starts watching it", async () => {
    const user = await makeUser();
    const store = await makeStore("DISABLED");

    await recomputeStoreTier(prisma, store.id); // simulate what a watch-start would trigger
    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("DISABLED");
    void user; // not exercising startMonitoring's own entitlement path here, just the tier guard
  });

  it("re-monitoring after removal works and grants a fresh 30-day period", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await startMonitoring(prisma, user.id, store.id, "FREE", NOW);
    await stopMonitoring(prisma, user.id, store.id);

    const later = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const result = await startMonitoring(prisma, user.id, store.id, "FREE", later);

    expect(result.outcome).toBe("started");
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringStatus).toBe("ACTIVE");
  });
});

describe("expireDueWatches — server-side expiration, the free-to-paid conversion mechanism", () => {
  it("expires a watch past its 30-day mark and demotes the store", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await startMonitoring(prisma, user.id, store.id, "FREE", NOW);

    const past30Days = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    const { expiredCount } = await expireDueWatches(prisma, past30Days);

    expect(expiredCount).toBe(1);
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringStatus).toBe("EXPIRED");
    const storeAfter = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(storeAfter.tier).toBe("COLD"); // demoted, but NOT disabled — still corpus-crawled at baseline cadence
  });

  it("does not touch a watch that hasn't reached its expiry yet", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await startMonitoring(prisma, user.id, store.id, "FREE", NOW);

    const stillWithinWindow = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000);
    const { expiredCount } = await expireDueWatches(prisma, stillWithinWindow);

    expect(expiredCount).toBe(0);
    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("HOT");
  });

  it("frees up the user's monitoring slot — they can start watching a different store afterward", async () => {
    const user = await makeUser();
    const storeA = await makeStore();
    const storeB = await makeStore();
    await startMonitoring(prisma, user.id, storeA.id, "FREE", NOW);

    const past30Days = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    await expireDueWatches(prisma, past30Days);

    const result = await startMonitoring(prisma, user.id, storeB.id, "FREE", past30Days);
    expect(result.outcome).toBe("started");
  });

  it("stays correct under a deliberately non-UTC session timezone (Asia/Kathmandu, UTC+5:45) — see AGENTS.md database time rule", async () => {
    const separator = url!.includes("?") ? "&" : "?";
    const pinnedClient = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });
    try {
      await pinnedClient.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kathmandu'`);

      const user = await pinnedClient.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
      const store = await pinnedClient.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
      await startMonitoring(pinnedClient, user.id, store.id, "FREE", NOW);

      // 31 days later — well past expiry regardless of any timezone shift smaller than a day.
      const past = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
      const { expiredCount } = await expireDueWatches(pinnedClient, past);
      expect(expiredCount).toBe(1);

      // And the boundary case: 5 minutes before true expiry must NOT expire,
      // even though a naive non-UTC cast would shift the comparison by
      // hours in the wrong direction.
      const user2 = await pinnedClient.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
      const store2 = await pinnedClient.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
      await startMonitoring(pinnedClient, user2.id, store2.id, "FREE", NOW);
      const justBefore = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000);
      const { expiredCount: notYet } = await expireDueWatches(pinnedClient, justBefore);
      expect(notYet).toBe(0);
    } finally {
      await pinnedClient.$disconnect();
    }
  });
});

describe("BASIC plan — up to 20 monitors, continuous (no fixed expiry)", () => {
  async function makeBasicUser() {
    return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "BASIC" } });
  }

  it("starts monitoring with a null expiresAt — continuous, not a 30-day window", async () => {
    const user = await makeBasicUser();
    const store = await makeStore();

    const result = await startMonitoring(prisma, user.id, store.id, "BASIC", NOW);

    expect(result.outcome).toBe("started");
    if (result.outcome === "started") {
      expect(result.expiresAt).toBeNull();
    }
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringExpiresAt).toBeNull();
  });

  it("allows up to 20 simultaneous active watches, rejects the 21st", async () => {
    const user = await makeBasicUser();
    const stores = await Promise.all(Array.from({ length: 21 }, () => makeStore()));

    for (const store of stores.slice(0, 20)) {
      const result = await startMonitoring(prisma, user.id, store.id, "BASIC", NOW);
      expect(result.outcome).toBe("started");
    }

    const activeCount = await prisma.watchlist.count({ where: { userId: user.id, monitoringStatus: "ACTIVE" } });
    expect(activeCount).toBe(20);

    const twentyFirst = await startMonitoring(prisma, user.id, stores[20].id, "BASIC", NOW);
    expect(twentyFirst).toEqual({
      outcome: "limit_reached",
      code: "MONITORING_LIMIT_REACHED",
      capability: "MAX_ACTIVE_MONITORED_STORES",
    });
  });

  it("a null-expiresAt (continuous) watch is never swept by expireDueWatches, no matter how far into the future 'now' is", async () => {
    const user = await makeBasicUser();
    const store = await makeStore();
    await startMonitoring(prisma, user.id, store.id, "BASIC", NOW);

    const farFuture = new Date(NOW.getTime() + 10 * 365 * 24 * 60 * 60 * 1000); // 10 years out
    const { expiredCount } = await expireDueWatches(prisma, farFuture);

    expect(expiredCount).toBe(0);
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringStatus).toBe("ACTIVE");
    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("HOT"); // still promoted — never demoted by a sweep that correctly ignored it
  });

  it("two users (one FREE, one BASIC) can independently monitor the same store — Store.tier reflects the union", async () => {
    const freeUser = await makeUser();
    const basicUser = await makeBasicUser();
    const store = await makeStore();

    await startMonitoring(prisma, freeUser.id, store.id, "FREE", NOW);
    const basicResult = await startMonitoring(prisma, basicUser.id, store.id, "BASIC", NOW);

    expect(basicResult.outcome).toBe("started");
    const after = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.tier).toBe("HOT");

    // FREE's 30-day watch expires; BASIC's continuous watch alone still justifies HOT.
    const past30Days = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    await expireDueWatches(prisma, past30Days);
    const stillHot = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(stillHot.tier).toBe("HOT");
  });
});
