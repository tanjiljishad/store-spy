import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { countAnalysesInWindow, getAnalysisUsage, hasAnalyzedStore, hasAnalyzedStoreInWindow, recordAnalysisUsage } from "../analysis-usage";

/**
 * Milestone 12 §1.2: the windowed ledger replaces the old lifetime "unique
 * stores ever analyzed" model — one row per analysis RUN, quota is "how
 * many in the last 24h," and the SAME store can appear more than once
 * across different windows. See run via `npm run test:integration` — see
 * persist.integration.test.ts for why DATABASE_URL is guarded this way
 * (this suite truncates every table).
 */

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`));
async function makeUser(plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") { return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan } }); }
async function makeStore() { return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } }); }

describe("analysis usage ledger under the freemium model", () => {
  it("lets FREE analyze up to its 10/24h limit across distinct stores", async () => {
    const user = await makeUser();
    const stores = await Promise.all(Array.from({ length: 5 }, makeStore));
    for (const store of stores) expect((await recordAnalysisUsage(prisma, user.id, store.id, "FREE")).outcome).toBe("recorded");
    expect(await getAnalysisUsage(prisma, user.id)).toMatchObject({ used: 5, limit: 10 });
  });

  it("D2: a repeat analysis of the same store WITHIN the window does not consume a credit", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await recordAnalysisUsage(prisma, user.id, store.id, "FREE");
    expect((await recordAnalysisUsage(prisma, user.id, store.id, "FREE")).outcome).toBe("already_counted");
    expect((await getAnalysisUsage(prisma, user.id)).used).toBe(1);
  });

  it("D2: a repeat analysis of the same store OUTSIDE the window DOES consume a fresh credit", async () => {
    const user = await makeUser();
    const store = await makeStore();
    const firstRow = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    // Backdate the first row past the 24h window — simulating "analyzed
    // yesterday, revisited today" without waiting a real day.
    await prisma.analysisUsage.update({ where: { id: firstRow.id }, data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) } });

    const result = await recordAnalysisUsage(prisma, user.id, store.id, "FREE");
    expect(result.outcome).toBe("recorded"); // NOT already_counted — the old row fell outside the window
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(2);
    // The windowed count only sees the fresh row — the backdated one is outside the window.
    expect(await countAnalysesInWindow(prisma, user.id)).toBe(1);
  });

  it("the 10th analysis in 24h succeeds; the 11th is rejected with LIMIT_REACHED and a correct resetsAt", async () => {
    const user = await makeUser();
    const stores = await Promise.all(Array.from({ length: 11 }, makeStore));

    for (let i = 0; i < 10; i++) {
      const result = await recordAnalysisUsage(prisma, user.id, stores[i].id, "FREE");
      expect(result.outcome).toBe("recorded");
    }

    const eleventh = await recordAnalysisUsage(prisma, user.id, stores[10].id, "FREE");
    expect(eleventh).toMatchObject({ outcome: "limit_reached", current: 10, max: 10 });
    if (eleventh.outcome !== "limit_reached") throw new Error("unreachable");
    expect(eleventh.resetsAt).not.toBeNull();
    // resetsAt is exactly 24h after the OLDEST row in the window (the 1st of the 10).
    const oldest = await prisma.analysisUsage.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(eleventh.resetsAt!.getTime()).toBe(oldest.createdAt.getTime() + 24 * 60 * 60_000);
    // The rejected 11th store never got a row written for it.
    expect(await prisma.analysisUsage.count({ where: { storeId: stores[10].id } })).toBe(0);
  });

  it("BASIC and BUSINESS enforce their own, higher, real limits — not unlimited", async () => {
    const basicUser = await makeUser("BASIC");
    const businessUser = await makeUser("BUSINESS");
    const [basicStore, businessStore] = await Promise.all([makeStore(), makeStore()]);

    expect(await getAnalysisUsage(prisma, basicUser.id)).toMatchObject({ used: 0, limit: 50 });
    expect(await getAnalysisUsage(prisma, businessUser.id)).toMatchObject({ used: 0, limit: 100 });

    await recordAnalysisUsage(prisma, basicUser.id, basicStore.id, "BASIC");
    await recordAnalysisUsage(prisma, businessUser.id, businessStore.id, "BUSINESS");
    expect((await getAnalysisUsage(prisma, basicUser.id)).used).toBe(1);
    expect((await getAnalysisUsage(prisma, businessUser.id)).used).toBe(1);
  });

  it("two concurrent analyses from a user with exactly one credit left produce exactly one recorded outcome (adapted Milestone 11 concurrency test)", async () => {
    const user = await makeUser();
    // Consume 9 of FREE's 10 credits up front, leaving exactly one slot.
    const usedStores = await Promise.all(Array.from({ length: 9 }, makeStore));
    for (const store of usedStores) {
      const result = await recordAnalysisUsage(prisma, user.id, store.id, "FREE");
      expect(result.outcome).toBe("recorded");
    }

    const [storeA, storeB] = await Promise.all([makeStore(), makeStore()]);
    const [resultA, resultB] = await Promise.all([
      recordAnalysisUsage(prisma, user.id, storeA.id, "FREE"),
      recordAnalysisUsage(prisma, user.id, storeB.id, "FREE"),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome].sort();
    expect(outcomes).toEqual(["limit_reached", "recorded"]);
    // Exactly 10 rows total — the lock serialized the two racing requests
    // rather than letting both see "9 < 10" and both insert.
    expect(await prisma.analysisUsage.count({ where: { userId: user.id } })).toBe(10);
  });

  it("hasAnalyzedStore is permanent (all-time) — unaffected by the window, unlike hasAnalyzedStoreInWindow", async () => {
    const user = await makeUser();
    const store = await makeStore();
    const row = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 48 * 60 * 60_000) } });

    expect(await hasAnalyzedStore(prisma, user.id, store.id)).toBe(true); // permanent — still true
    expect(await hasAnalyzedStoreInWindow(prisma, user.id, store.id)).toBe(false); // outside the 24h window
  });

  it("hasAnalyzedStore still works with duplicate rows for the same store (no longer a unique constraint)", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await prisma.analysisUsage.createMany({ data: [{ userId: user.id, storeId: store.id }, { userId: user.id, storeId: store.id }] });
    expect(await hasAnalyzedStore(prisma, user.id, store.id)).toBe(true);
  });
});
