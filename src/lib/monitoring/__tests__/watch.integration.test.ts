import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expireDueWatches, startMonitoring, stopMonitoring } from "../watch";
import { clearTrialCeiling } from "../../billing/subscription-sweep";
import { setTrialWindow, makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});
async function user(plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") { return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan }); }
async function store() { return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } }); }
const NOW = new Date("2026-08-11T12:00:00Z");

describe("monitoring entitlements", () => {
  it("FREE gets one monitor (capped at its trial ceiling) and cannot bypass the server-side limit", async () => {
    const account = await user(); const a = await store(); const b = await store();
    expect((await startMonitoring(prisma, account.id, a.id, "FREE", NOW)).outcome).toBe("started");
    expect(await startMonitoring(prisma, account.id, b.id, "FREE", NOW)).toMatchObject({ outcome: "limit_reached", current: 1, max: 1 });

    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: a.id } } });
    // Milestone 12 §1.4: unlike pre-M12 (no expiry at all), a FREE watch now
    // carries the account's trial ceiling — never null, and equal to
    // freeTrialEndsAt since monitoringDurationDays(FREE) is itself null
    // (min(freeTrialEndsAt, null) == freeTrialEndsAt).
    const freshUser = await prisma.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(watch.monitoringExpiresAt).not.toBeNull();
    expect(watch.monitoringExpiresAt!.getTime()).toBe(freshUser.freeTrialEndsAt!.getTime());
  });

  // Milestone 12 §1.4 acceptance criterion: "A FREE user's watch expires
  // when freeTrialEndsAt passes, and the store's tier recomputes." Replaces
  // the pre-M12 "a FREE monitor remains active after 30 days" test — that
  // premise no longer holds now that FREE carries a real trial ceiling.
  it("a FREE user's watch expires once freeTrialEndsAt passes, and the store's tier recomputes", async () => {
    const account = await user();
    await setTrialWindow(prisma, account.id, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000));
    const watched = await store();

    await startMonitoring(prisma, account.id, watched.id, "FREE", NOW);
    expect((await prisma.store.findUniqueOrThrow({ where: { id: watched.id } })).tier).toBe("HOT");

    const past31Days = new Date(NOW.getTime() + 31 * 24 * 60 * 60_000);
    const result = await expireDueWatches(prisma, past31Days);
    expect(result.expiredCount).toBe(1);

    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: watched.id } } });
    expect(watch.monitoringStatus).toBe("EXPIRED");
    expect((await prisma.store.findUniqueOrThrow({ where: { id: watched.id } })).tier).toBe("COLD");
  });

  // Milestone 12 §1.4: a trial-expired FREE user must not be able to start
  // a BRAND NEW watch either — without this guard, activeCount would read
  // back 0 (the old watch already expired) and comfortably pass the count
  // check, creating a watch whose min(freeTrialEndsAt, null) expiresAt is
  // already in the past — immediately eligible for the very next sweep.
  it("a FREE user whose trial already ended cannot start a NEW watch — rejected with trial_expired, not silently created-then-expired", async () => {
    const account = await user();
    const pastTrialEnd = new Date(NOW.getTime() - 24 * 60 * 60_000); // ended yesterday
    await setTrialWindow(prisma, account.id, pastTrialEnd);
    const watched = await store();

    const result = await startMonitoring(prisma, account.id, watched.id, "FREE", NOW);
    expect(result.outcome).toBe("trial_expired");
    expect(await prisma.watchlist.count({ where: { userId: account.id } })).toBe(0);
  });

  // Milestone 12 §1.4 acceptance criterion: "Upgrading FREE -> BASIC lifts
  // the trial ceiling on the existing watch."
  it("upgrading from FREE to a paid plan lifts the trial ceiling on an existing watch (clearTrialCeiling)", async () => {
    const account = await user();
    await setTrialWindow(prisma, account.id, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000));
    const watched = await store();
    await startMonitoring(prisma, account.id, watched.id, "FREE", NOW);

    const beforeUpgrade = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: watched.id } } });
    expect(beforeUpgrade.monitoringExpiresAt).not.toBeNull();

    await prisma.user.update({ where: { id: account.id }, data: { plan: "BASIC" } });
    await clearTrialCeiling(prisma, account.id);

    const afterUpgrade = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: watched.id } } });
    expect(afterUpgrade.monitoringExpiresAt).toBeNull();
    expect(afterUpgrade.monitoringStatus).toBe("ACTIVE"); // untouched otherwise
  });

  it("clearTrialCeiling is a no-op for a plan/watch set that never carried one", async () => {
    const account = await user("BASIC");
    const watched = await store();
    await startMonitoring(prisma, account.id, watched.id, "BASIC", NOW);
    await expect(clearTrialCeiling(prisma, account.id)).resolves.not.toThrow();
    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: account.id, storeId: watched.id } } });
    expect(watch.monitoringExpiresAt).toBeNull();
  });

  it("Milestone 12 §1.1: BASIC permits 20 monitors, rejects the 21st, and removal frees a slot", async () => {
    const account = await user("BASIC"); const stores = await Promise.all(Array.from({ length: 21 }, store));
    for (const watched of stores.slice(0, 20)) expect((await startMonitoring(prisma, account.id, watched.id, "BASIC", NOW)).outcome).toBe("started");
    expect(await startMonitoring(prisma, account.id, stores[20].id, "BASIC", NOW)).toMatchObject({ outcome: "limit_reached", current: 20, max: 20 });
    await stopMonitoring(prisma, account.id, stores[0].id);
    expect((await startMonitoring(prisma, account.id, stores[20].id, "BASIC", NOW)).outcome).toBe("started");
  });

  it("Milestone 12 §1.1: BUSINESS permits 50 monitors — a real, higher, non-identical limit to BASIC", async () => {
    const account = await user("BUSINESS"); const stores = await Promise.all(Array.from({ length: 3 }, store));
    for (const watched of stores) expect((await startMonitoring(prisma, account.id, watched.id, "BUSINESS", NOW)).outcome).toBe("started");
    expect(await prisma.watchlist.count({ where: { userId: account.id, monitoringStatus: "ACTIVE" } })).toBe(3);
  });
});
