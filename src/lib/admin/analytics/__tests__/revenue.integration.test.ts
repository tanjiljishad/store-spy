import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getRevenueMetrics } from "../revenue";
import { monthlyPriceCents } from "../../../billing/pricing";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "Subscription","Session","Account","User" RESTART IDENTITY CASCADE`));

const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-08T00:00:00Z");
const INSIDE = new Date("2026-08-05T12:00:00Z");
const BEFORE = new Date("2026-07-20T12:00:00Z");

async function makeUser() {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com` } });
}

describe("getRevenueMetrics", () => {
  it("MRR at windowEnd sums monthlyPriceCents over subscriptions ACTIVE at windowEnd, grouped by plan", async () => {
    const basicUser = await makeUser();
    const businessUser = await makeUser();
    await prisma.subscription.create({ data: { userId: basicUser.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE } });
    await prisma.subscription.create({ data: { userId: businessUser.id, plan: "BUSINESS", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE } });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.mrrCentsByPlan.BASIC).toBe(monthlyPriceCents("BASIC"));
    expect(metrics.mrrCentsByPlan.BUSINESS).toBe(monthlyPriceCents("BUSINESS"));
    expect(metrics.mrrCentsTotal).toBe(monthlyPriceCents("BASIC") + monthlyPriceCents("BUSINESS"));
    expect(metrics.activeSubscriptionsByPlan).toEqual({ FREE: 0, BASIC: 1, BUSINESS: 1 });
  });

  it("a subscription that started after windowEnd, or already expired by windowEnd, is excluded from MRR", async () => {
    const futureUser = await makeUser();
    await prisma.subscription.create({
      data: { userId: futureUser.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: new Date("2026-08-09T00:00:00Z") },
    });
    const expiredUser = await makeUser();
    await prisma.subscription.create({
      data: { userId: expiredUser.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE, expiresAt: new Date("2026-08-02T00:00:00Z") },
    });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.mrrCentsTotal).toBe(0);
  });

  it("ARPU divides MRR by DISTINCT paying users, not row count — a user with two simultaneous ACTIVE rows is not double-counted", async () => {
    const user = await makeUser();
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE } });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.activePayingUserCount).toBe(1);
    // MRR still counts both rows (real revenue, even if double-booked) but ARPU divides by the one real payer.
    expect(metrics.mrrCentsTotal).toBe(monthlyPriceCents("BASIC") * 2);
    expect(metrics.arpuCents).toBe(monthlyPriceCents("BASIC") * 2);
  });

  it("new MRR counts only a user's first-ever subscription starting inside the window", async () => {
    const newPayer = await makeUser();
    await prisma.subscription.create({ data: { userId: newPayer.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: INSIDE } });

    const returningPayer = await makeUser();
    await prisma.subscription.create({ data: { userId: returningPayer.id, plan: "BASIC", source: "PROVIDER", status: "EXPIRED", startedAt: BEFORE, expiresAt: BEFORE } });
    await prisma.subscription.create({ data: { userId: returningPayer.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: INSIDE } });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    // Only newPayer's subscription is a genuine first-ever row — returningPayer's second row is not "new."
    expect(metrics.newMrrCents).toBe(monthlyPriceCents("BASIC"));
  });

  it("expansion MRR is the positive price delta vs. the immediately preceding plan; contraction MRR is the negative delta", async () => {
    const upgrader = await makeUser();
    await prisma.subscription.create({ data: { userId: upgrader.id, plan: "BASIC", source: "PROVIDER", status: "EXPIRED", startedAt: BEFORE, expiresAt: BEFORE } });
    await prisma.subscription.create({ data: { userId: upgrader.id, plan: "BUSINESS", source: "PROVIDER", status: "ACTIVE", startedAt: INSIDE } });

    const downgrader = await makeUser();
    await prisma.subscription.create({ data: { userId: downgrader.id, plan: "BUSINESS", source: "PROVIDER", status: "EXPIRED", startedAt: BEFORE, expiresAt: BEFORE } });
    await prisma.subscription.create({ data: { userId: downgrader.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: INSIDE } });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.expansionMrrCents).toBe(monthlyPriceCents("BUSINESS") - monthlyPriceCents("BASIC"));
    expect(metrics.contractionMrrCents).toBe(monthlyPriceCents("BUSINESS") - monthlyPriceCents("BASIC"));
  });

  it("churned MRR sums the plan price of subscriptions that expired inside the window", async () => {
    const churned = await makeUser();
    await prisma.subscription.create({
      data: { userId: churned.id, plan: "BUSINESS", source: "PROVIDER", status: "EXPIRED", startedAt: BEFORE, expiresAt: INSIDE },
    });
    const stillActive = await makeUser();
    await prisma.subscription.create({ data: { userId: stillActive.id, plan: "BUSINESS", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE } });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.churnedMrrCents).toBe(monthlyPriceCents("BUSINESS"));
  });

  it("promo-granted vs. paid subscriptions are broken out by source", async () => {
    const promoUser = await makeUser();
    await prisma.subscription.create({ data: { userId: promoUser.id, plan: "BASIC", source: "PROMO", status: "ACTIVE", startedAt: BEFORE } });
    const paidUser = await makeUser();
    await prisma.subscription.create({ data: { userId: paidUser.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE", startedAt: BEFORE } });

    const metrics = await getRevenueMetrics(prisma, WINDOW_START, WINDOW_END);
    expect(metrics.activeSubscriptionsBySource.PROMO).toBe(1);
    expect(metrics.activeSubscriptionsBySource.PROVIDER).toBe(1);
  });
});
