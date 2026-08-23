import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getActivationMetrics } from "../activation";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () =>
  prisma.$executeRawUnsafe(`TRUNCATE "Watchlist","AnalysisUsage","Session","Account","Store","User" RESTART IDENTITY CASCADE`),
);

const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-08T00:00:00Z");

async function makeUser(createdAt: Date) {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com` } });
  await prisma.user.update({ where: { id: user.id }, data: { createdAt } });
  return user;
}
async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("getActivationMetrics", () => {
  it("counts a signup as activated only if their first analysis is within 24h of signup — not merely within the reporting window", async () => {
    const signedUpAt = new Date("2026-08-03T00:00:00Z");
    const store = await makeStore();

    const activated = await makeUser(signedUpAt);
    const row1 = await prisma.analysisUsage.create({ data: { userId: activated.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: row1.id }, data: { createdAt: new Date(signedUpAt.getTime() + 23 * 60 * 60_000) } });

    // Same window, same user creation time, but their first analysis was 30h
    // later — still inside the WINDOW, but past the 24h activation cutoff.
    const notActivated = await makeUser(signedUpAt);
    const row2 = await prisma.analysisUsage.create({ data: { userId: notActivated.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: row2.id }, data: { createdAt: new Date(signedUpAt.getTime() + 30 * 60 * 60_000) } });

    const metrics = await getActivationMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.signups).toBe(2);
    expect(metrics.activatedWithin24h).toBe(1);
    expect(metrics.activation24hRate).toBeCloseTo(0.5, 5);
  });

  it("counts a signup as having added a watch only if it happened within 7 days of signup", async () => {
    const signedUpAt = new Date("2026-08-03T00:00:00Z");
    const store = await makeStore();

    const watched = await makeUser(signedUpAt);
    const w1 = await prisma.watchlist.create({ data: { userId: watched.id, storeId: store.id } });
    await prisma.watchlist.update({ where: { id: w1.id }, data: { addedAt: new Date(signedUpAt.getTime() + 6 * 24 * 60 * 60_000) } });

    const notWatched = await makeUser(signedUpAt);
    const w2 = await prisma.watchlist.create({ data: { userId: notWatched.id, storeId: store.id } });
    await prisma.watchlist.update({ where: { id: w2.id }, data: { addedAt: new Date(signedUpAt.getTime() + 8 * 24 * 60 * 60_000) } });

    const metrics = await getActivationMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.watchedWithin7d).toBe(1);
    expect(metrics.watch7dRate).toBeCloseTo(0.5, 5);
  });

  it("zero signups in the window yields null rates, not division by zero", async () => {
    const metrics = await getActivationMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.signups).toBe(0);
    expect(metrics.activation24hRate).toBeNull();
    expect(metrics.watch7dRate).toBeNull();
  });
});
