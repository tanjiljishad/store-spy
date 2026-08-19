import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getAnalysisUsage, recordAnalysisUsage } from "../analysis-usage";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`));
async function makeUser(plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") { return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan } }); }
async function makeStore() { return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } }); }

describe("analysis usage ledger under the freemium model", () => {
  it("lets FREE analyze stores 1 through 5 and reports no lifetime limit", async () => {
    const user = await makeUser();
    const stores = await Promise.all(Array.from({ length: 5 }, makeStore));
    for (const store of stores) expect((await recordAnalysisUsage(prisma, user.id, store.id, "FREE")).outcome).toBe("recorded");
    expect(await getAnalysisUsage(prisma, user.id)).toMatchObject({ used: 5, limit: null });
  });

  it("preserves analytics/ownership history without double-counting a revisited store", async () => {
    const user = await makeUser();
    const store = await makeStore();
    await recordAnalysisUsage(prisma, user.id, store.id, "FREE");
    expect((await recordAnalysisUsage(prisma, user.id, store.id, "FREE")).outcome).toBe("already_counted");
    expect((await getAnalysisUsage(prisma, user.id)).used).toBe(1);
  });
});
