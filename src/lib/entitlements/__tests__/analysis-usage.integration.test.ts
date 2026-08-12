import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getAnalysisUsage, recordAnalysisUsage } from "../analysis-usage";

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

async function makeUser(plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan } });
}
async function makeStore(domain?: string) {
  return prisma.store.create({ data: { domain: domain ?? `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("recordAnalysisUsage — the exact 3-unique-stores contract", () => {
  it("records the first three unique stores", async () => {
    const user = await makeUser();
    const [s1, s2, s3] = await Promise.all([makeStore(), makeStore(), makeStore()]);

    expect((await recordAnalysisUsage(prisma, user.id, s1.id, "FREE")).outcome).toBe("recorded");
    expect((await recordAnalysisUsage(prisma, user.id, s2.id, "FREE")).outcome).toBe("recorded");
    expect((await recordAnalysisUsage(prisma, user.id, s3.id, "FREE")).outcome).toBe("recorded");

    const usage = await getAnalysisUsage(prisma, user.id);
    expect(usage.used).toBe(3);
    expect(usage.limit).toBe(3);
  });

  it("rejects a fourth unique store", async () => {
    const user = await makeUser();
    const stores = await Promise.all([makeStore(), makeStore(), makeStore(), makeStore()]);
    for (const s of stores.slice(0, 3)) {
      await recordAnalysisUsage(prisma, user.id, s.id, "FREE");
    }

    const fourth = await recordAnalysisUsage(prisma, user.id, stores[3].id, "FREE");
    expect(fourth).toEqual({ outcome: "limit_reached", code: "ANALYSIS_LIMIT_REACHED", capability: "MAX_UNIQUE_ANALYSES" });

    const usage = await getAnalysisUsage(prisma, user.id);
    expect(usage.used).toBe(3); // the rejected attempt did not get recorded
  });

  it("re-analyzing an already-counted store does not consume another credit", async () => {
    const user = await makeUser();
    const store = await makeStore();

    await recordAnalysisUsage(prisma, user.id, store.id, "FREE");
    const second = await recordAnalysisUsage(prisma, user.id, store.id, "FREE");

    expect(second.outcome).toBe("already_counted");
    const usage = await getAnalysisUsage(prisma, user.id);
    expect(usage.used).toBe(1);
  });

  it("does not let two simultaneous requests from a one-credit-remaining user consume two credits", async () => {
    const user = await makeUser();
    const stores = await Promise.all([makeStore(), makeStore(), makeStore(), makeStore()]);
    // Use up 2 of 3 credits, leaving exactly one slot.
    await recordAnalysisUsage(prisma, user.id, stores[0].id, "FREE");
    await recordAnalysisUsage(prisma, user.id, stores[1].id, "FREE");

    // Race two DIFFERENT new stores for the user's last remaining credit.
    const [a, b] = await Promise.all([
      recordAnalysisUsage(prisma, user.id, stores[2].id, "FREE"),
      recordAnalysisUsage(prisma, user.id, stores[3].id, "FREE"),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["limit_reached", "recorded"]); // exactly one wins, one is rejected — never both

    const usage = await getAnalysisUsage(prisma, user.id);
    expect(usage.used).toBe(3); // never overshoots
  });

  it("different users never block each other's usage checks", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const store = await makeStore();

    const [a, b] = await Promise.all([
      recordAnalysisUsage(prisma, userA.id, store.id, "FREE"),
      recordAnalysisUsage(prisma, userB.id, store.id, "FREE"),
    ]);

    expect(a.outcome).toBe("recorded");
    expect(b.outcome).toBe("recorded"); // same store, but two different users — both get their own credit
  });
});

describe("recordAnalysisUsage — BASIC plan's unlimited analyses (null, not a large integer)", () => {
  it("never rejects, however many unique stores are analyzed", async () => {
    const user = await makeUser("BASIC");
    const stores = await Promise.all(Array.from({ length: 5 }, () => makeStore()));

    for (const store of stores) {
      const result = await recordAnalysisUsage(prisma, user.id, store.id, "BASIC");
      expect(result.outcome).toBe("recorded");
    }

    const usage = await getAnalysisUsage(prisma, user.id);
    expect(usage.used).toBe(5);
    expect(usage.limit).toBeNull(); // unlimited is represented as null, never e.g. 999999
  });

  it("still doesn't double-count a repeat analysis of the same store", async () => {
    const user = await makeUser("BASIC");
    const store = await makeStore();

    await recordAnalysisUsage(prisma, user.id, store.id, "BASIC");
    const second = await recordAnalysisUsage(prisma, user.id, store.id, "BASIC");

    expect(second.outcome).toBe("already_counted");
    const usage = await getAnalysisUsage(prisma, user.id);
    expect(usage.used).toBe(1);
  });
});
