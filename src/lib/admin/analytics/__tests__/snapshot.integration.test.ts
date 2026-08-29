import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { computeAndStoreSnapshots } from "../snapshot";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MetricSnapshot","AnonymousAnalysis","Subscription","Watchlist","AnalysisUsage","MarketingCollectionRun","Crawl","PromoRedemption","PromoCode","Session","Account","Store","User" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

const NOW = new Date("2026-08-21T14:37:00Z");

describe("computeAndStoreSnapshots", () => {
  it("writes rows on a cold table (never computed before), and includes a real funnel metric for the 1d window", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: user.id }, data: { createdAt: new Date("2026-08-21T10:00:00Z") } });

    const result = await computeAndStoreSnapshots(prisma, NOW);
    expect(result.computed).toBe(true);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const signupSnapshot = await prisma.metricSnapshot.findFirst({ where: { metricKey: "funnel.signups:1d" } });
    expect(signupSnapshot?.value).toBe(1);
  });

  it("self-gates to hourly: a second call within the minimum interval is a no-op", async () => {
    const first = await computeAndStoreSnapshots(prisma, NOW);
    expect(first.computed).toBe(true);

    const second = await computeAndStoreSnapshots(prisma, new Date(NOW.getTime() + 10 * 60_000)); // 10 minutes later
    expect(second.computed).toBe(false);
    expect(second.rowsWritten).toBe(0);
  });

  it("a call after the minimum interval recomputes and overwrites the same row in place (upsert, not a new one)", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: user.id }, data: { createdAt: new Date("2026-08-21T10:00:00Z") } });

    await computeAndStoreSnapshots(prisma, NOW);
    const rowCountAfterFirst = await prisma.metricSnapshot.count({ where: { metricKey: "funnel.signups:1d" } });
    expect(rowCountAfterFirst).toBe(1);

    // A second signup, then recompute a full hour later.
    const secondUser = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: secondUser.id }, data: { createdAt: new Date("2026-08-21T15:30:00Z") } });
    const later = new Date(NOW.getTime() + 60 * 60_000 + 1);
    const result = await computeAndStoreSnapshots(prisma, later);
    expect(result.computed).toBe(true);

    const rowCountAfterSecond = await prisma.metricSnapshot.count({ where: { metricKey: "funnel.signups:1d" } });
    expect(rowCountAfterSecond).toBe(1); // still exactly one row for this (metricKey, dimension, window) — overwritten, not duplicated
  });

  it("writes a revenue snapshot dimensioned by plan", async () => {
    const businessUser = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "BUSINESS" });
    await prisma.subscription.create({
      data: { userId: businessUser.id, plan: "BUSINESS", source: "PROVIDER", status: "ACTIVE", startedAt: new Date("2026-07-01T00:00:00Z") },
    });

    await computeAndStoreSnapshots(prisma, NOW);
    const mrr = await prisma.metricSnapshot.findFirst({ where: { metricKey: "revenue.mrr_cents:90d", dimension: "BUSINESS" } });
    expect(mrr?.value).toBe(4900);
  });

  it("writes retention rows keyed by cohort month", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: user.id }, data: { createdAt: new Date("2026-07-15T00:00:00Z") } });

    await computeAndStoreSnapshots(prisma, NOW);
    const cohort = await prisma.metricSnapshot.findFirst({
      where: { metricKey: "retention.cohort_size", windowStart: new Date("2026-07-01T00:00:00Z") },
    });
    expect(cohort?.value).toBe(1);
  });

  it("writes daily-trend rows keyed by UTC day and plan", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    const store = await prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
    const usage = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: usage.id }, data: { createdAt: new Date("2026-08-20T09:00:00Z") } });

    await computeAndStoreSnapshots(prisma, NOW);
    const point = await prisma.metricSnapshot.findFirst({
      where: { metricKey: "usage_cost.analyses_per_day", windowStart: new Date("2026-08-20T00:00:00Z"), dimension: "FREE" },
    });
    expect(point?.value).toBe(1);
  });
});
