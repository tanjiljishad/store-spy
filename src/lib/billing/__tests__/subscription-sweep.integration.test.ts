import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expireDueSubscriptions } from "../subscription-sweep";
import { maxActiveMonitoredStores } from "../../entitlements/entitlement-service";

/**
 * Milestone 11 Phase 3 §3.4 amendment's four required tests. Deliberately
 * asserted against the REAL plan-limits.ts constants
 * (maxActiveMonitoredStores), never a hardcoded number — this is exactly
 * what "Gate 1" (settling the plan numbers before Phase 3) was for: these
 * tests are correct regardless of what the actual FREE/BASIC limits are,
 * as long as they're read from the one real source of truth.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","Watchlist","Subscription","Store","User" RESTART IDENTITY CASCADE`,
  );
});

async function makeUser(plan: "FREE" | "BASIC" = "BASIC") {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan } });
}
async function makeStore(tier: "HOT" | "COLD" = "HOT") {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY", tier } });
}
async function makeWatch(userId: string, storeId: string, monitoringStartedAt: Date) {
  return prisma.watchlist.create({
    data: { userId, storeId, monitoringStartedAt, monitoringStatus: "ACTIVE", monitoringExpiresAt: null },
  });
}

describe("expireDueSubscriptions — the amendment's four required tests", () => {
  it("1. expiry reverts the plan to FREE", async () => {
    const user = await makeUser("BASIC");
    await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await expireDueSubscriptions(prisma);
    expect(result.expiredCount).toBe(1);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.plan).toBe("FREE");

    const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    expect(sub.status).toBe("EXPIRED");
  });

  it("2. a paid user with more active watches than FREE allows downgrades to exactly maxActiveMonitoredStores(FREE) retained, oldest first", async () => {
    const user = await makeUser("BASIC");
    await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) },
    });

    const freeLimit = maxActiveMonitoredStores("FREE");
    if (freeLimit === null) throw new Error("this test requires a finite FREE monitoring limit");
    const totalWatches = freeLimit + 5; // deliberately more than FREE allows

    const stores = await Promise.all(Array.from({ length: totalWatches }, () => makeStore()));
    const now = Date.now();
    // Oldest first: watch[0] is the oldest, watch[N-1] is the newest.
    const watches = await Promise.all(
      stores.map((s, i) => makeWatch(user.id, s.id, new Date(now - (totalWatches - i) * 60_000))),
    );

    await expireDueSubscriptions(prisma);

    const active = await prisma.watchlist.findMany({ where: { userId: user.id, monitoringStatus: "ACTIVE" } });
    const expired = await prisma.watchlist.findMany({ where: { userId: user.id, monitoringStatus: "EXPIRED" } });

    expect(active).toHaveLength(freeLimit);
    expect(expired).toHaveLength(totalWatches - freeLimit);

    // The retained ones are exactly the OLDEST `freeLimit` watches.
    const retainedIds = new Set(active.map((w) => w.id));
    const expectedRetainedIds = new Set(watches.slice(0, freeLimit).map((w) => w.id));
    expect(retainedIds).toEqual(expectedRetainedIds);
  });

  it("3. every store affected by the cascade has its tier recomputed", async () => {
    const user = await makeUser("BASIC");
    await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) },
    });

    const freeLimit = maxActiveMonitoredStores("FREE");
    if (freeLimit === null) throw new Error("this test requires a finite FREE monitoring limit");

    const now = Date.now();
    // `freeLimit` OLDER watches, one per store — all retained.
    const retainedStores = await Promise.all(Array.from({ length: freeLimit }, () => makeStore("HOT")));
    await Promise.all(retainedStores.map((s, i) => makeWatch(user.id, s.id, new Date(now - (freeLimit - i + 1) * 60_000))));
    // One NEWER watch, on its own store — this is the "+1 beyond the
    // limit" that becomes excess and loses its only watcher.
    const willBeExpired = await makeStore("HOT");
    await makeWatch(user.id, willBeExpired.id, new Date(now));

    await expireDueSubscriptions(prisma);

    const expiredStoreState = await prisma.store.findUniqueOrThrow({ where: { id: willBeExpired.id } });
    expect(expiredStoreState.tier).toBe("COLD"); // lost its only watcher, recomputed down

    const retainedStoreState = await prisma.store.findUniqueOrThrow({ where: { id: retainedStores[0].id } });
    expect(retainedStoreState.tier).toBe("HOT"); // still watched — recompute must not wrongly touch it
  });

  it("4. a Subscription with expiresAt: null survives the sweep untouched, indefinitely", async () => {
    const user = await makeUser("BASIC");
    const sub = await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: null },
    });

    const result = await expireDueSubscriptions(prisma);
    expect(result.expiredCount).toBe(0);

    const stillSub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(stillSub.status).toBe("ACTIVE");

    const stillUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillUser.plan).toBe("BASIC"); // never downgraded
  });

  it("does not touch a subscription that is not yet due", async () => {
    const user = await makeUser("BASIC");
    await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() + 60 * 60_000) },
    });

    const result = await expireDueSubscriptions(prisma);
    expect(result.expiredCount).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).plan).toBe("BASIC");
  });

  it("isolates a failure on one subscription from the rest of the sweep", async () => {
    const userA = await makeUser("BASIC");
    const userB = await makeUser("BASIC");
    await prisma.subscription.create({ data: { userId: userA.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) } });
    await prisma.subscription.create({ data: { userId: userB.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) } });

    // Delete userA's User row out from under its own due Subscription to
    // force expireOneSubscription's internal transaction to fail for that
    // one row (a real, not simulated, failure mode) — userB must still process.
    await prisma.user.delete({ where: { id: userA.id } });

    const result = await expireDueSubscriptions(prisma);
    expect(result.expiredCount).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userB.id } })).plan).toBe("FREE");
  });

  it("writes exactly one audit row per downgraded subscription, with actor system:expiry", async () => {
    const user = await makeUser("BASIC");
    await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) },
    });

    await expireDueSubscriptions(prisma);

    const auditRows = await prisma.adminAuditLog.findMany({ where: { targetId: user.id, action: "subscription.expire" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actorId).toBe("system:expiry");
  });

  // Milestone 12 §4.1 addendum: metadata.userEmail was the concrete
  // real-world violation of the "never embed the subject's email" rule —
  // regression-locked here against a real audit row, not just the unit-level
  // recordAdminAction() guard.
  it("the audit row's metadata never contains the downgraded user's email, only their id (already targetId)", async () => {
    const user = await makeUser("BASIC");
    await prisma.subscription.create({
      data: { userId: user.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) },
    });

    await expireDueSubscriptions(prisma);

    const auditRow = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: user.id, action: "subscription.expire" } });
    expect(auditRow.metadata).not.toHaveProperty("userEmail");
    expect(JSON.stringify(auditRow.metadata)).not.toContain(user.email);
  });
});
