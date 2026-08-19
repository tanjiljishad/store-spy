import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expireDueWatches, startMonitoring, stopMonitoring } from "../watch";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`));
async function user(plan: "FREE" | "BASIC" = "FREE") { return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan } }); }
async function store() { return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } }); }
const NOW = new Date("2026-08-11T12:00:00Z");

describe("monitoring entitlements", () => {
  it("FREE gets one non-expiring monitor and cannot bypass the server-side limit", async () => {
    const account = await user(); const a = await store(); const b = await store();
    expect((await startMonitoring(prisma, account.id, a.id, "FREE", NOW)).outcome).toBe("started");
    expect(await startMonitoring(prisma, account.id, b.id, "FREE", NOW)).toMatchObject({ outcome: "limit_reached", code: "MONITORING_LIMIT_REACHED" });
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: a.id } } });
    expect(watch.monitoringExpiresAt).toBeNull();
  });

  it("a FREE monitor remains active after 30 days", async () => {
    const account = await user(); const watched = await store();
    await startMonitoring(prisma, account.id, watched.id, "FREE", NOW);
    expect((await expireDueWatches(prisma, new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000))).expiredCount).toBe(0);
    expect((await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: watched.id } } })).monitoringStatus).toBe("ACTIVE");
  });

  it("retained BASIC compatibility permits 10 monitors, rejects the 11th, and removal frees a slot", async () => {
    const account = await user("BASIC"); const stores = await Promise.all(Array.from({ length: 11 }, store));
    for (const watched of stores.slice(0, 10)) expect((await startMonitoring(prisma, account.id, watched.id, "BASIC", NOW)).outcome).toBe("started");
    expect(await startMonitoring(prisma, account.id, stores[10].id, "BASIC", NOW)).toMatchObject({ outcome: "limit_reached" });
    await stopMonitoring(prisma, account.id, stores[0].id);
    expect((await startMonitoring(prisma, account.id, stores[10].id, "BASIC", NOW)).outcome).toBe("started");
  });
});
