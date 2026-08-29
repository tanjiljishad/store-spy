import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getFunnelCounts } from "../funnel";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";

/**
 * Milestone 12 §3.1/§3.2: raw SQL against seeded fixtures, not whatever
 * happens to already be in the dev database — see persist.integration.test.ts
 * for why DATABASE_URL is guarded this way (this suite truncates every table).
 */
const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AnonymousAnalysis","Subscription","Watchlist","AnalysisUsage","Session","Account","Store" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-08T00:00:00Z");
const INSIDE = new Date("2026-08-05T12:00:00Z");
const BEFORE = new Date("2026-07-20T12:00:00Z");
const AFTER = new Date("2026-08-10T12:00:00Z");

async function makeUser(createdAt: Date) {
  const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
  await prisma.cpUser.update({ where: { id: user.id }, data: { createdAt } });
  return user;
}
async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("getFunnelCounts", () => {
  it("counts anonymous analyses only inside the window", async () => {
    await prisma.anonymousAnalysis.create({ data: { ipKey: "1.1.1.1", domain: "a.com", createdAt: INSIDE } });
    await prisma.anonymousAnalysis.create({ data: { ipKey: "2.2.2.2", domain: "b.com", createdAt: BEFORE } });
    await prisma.anonymousAnalysis.create({ data: { ipKey: "3.3.3.3", domain: "c.com", createdAt: AFTER } });

    const counts = await getFunnelCounts(prisma, WINDOW_START, WINDOW_END);
    expect(counts.anonymousAnalyses).toBe(1);
  });

  it("counts signups by User.createdAt inside the window", async () => {
    await makeUser(INSIDE);
    await makeUser(BEFORE);
    await makeUser(AFTER);

    const counts = await getFunnelCounts(prisma, WINDOW_START, WINDOW_END);
    expect(counts.signups).toBe(1);
  });

  it("counts a user's FIRST analysis only — a second, later analysis by the same user inside the window does not double-count them", async () => {
    const user = await makeUser(BEFORE);
    const store = await makeStore();
    const firstRow = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: firstRow.id }, data: { createdAt: INSIDE } });
    // A second analysis by the SAME user, also inside the window — must not add a second "first analysis".
    const secondRow = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: secondRow.id }, data: { createdAt: new Date(INSIDE.getTime() + 60_000) } });

    // A different user whose first analysis falls OUTSIDE the window must not count either.
    const otherUser = await makeUser(BEFORE);
    const otherRow = await prisma.analysisUsage.create({ data: { userId: otherUser.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: otherRow.id }, data: { createdAt: AFTER } });

    const counts = await getFunnelCounts(prisma, WINDOW_START, WINDOW_END);
    expect(counts.firstAnalyses).toBe(1);
  });

  it("counts a user's first watch inside the window", async () => {
    const user = await makeUser(BEFORE);
    const store = await makeStore();
    const watch = await prisma.watchlist.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.watchlist.update({ where: { id: watch.id }, data: { addedAt: INSIDE } });

    const counts = await getFunnelCounts(prisma, WINDOW_START, WINDOW_END);
    expect(counts.firstWatches).toBe(1);
  });

  it("counts a user's first-ever subscription (any source) as reaching the paid step inside the window", async () => {
    const user = await makeUser(BEFORE);
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", source: "MANUAL", status: "ACTIVE", startedAt: INSIDE } });

    const counts = await getFunnelCounts(prisma, WINDOW_START, WINDOW_END);
    expect(counts.firstPaidConversions).toBe(1);
  });

  it("a user's SECOND subscription (e.g. an upgrade) inside the window does not count as a fresh paid conversion", async () => {
    const user = await makeUser(BEFORE);
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", source: "MANUAL", status: "EXPIRED", startedAt: BEFORE } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "BUSINESS", source: "MANUAL", status: "ACTIVE", startedAt: INSIDE } });

    const counts = await getFunnelCounts(prisma, WINDOW_START, WINDOW_END);
    expect(counts.firstPaidConversions).toBe(0);
  });
});
