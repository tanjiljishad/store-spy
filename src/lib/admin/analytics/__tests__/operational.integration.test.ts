import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getOperationalMetrics } from "../operational";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "PromoRedemption","PromoCode","Store" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

const NOW = new Date("2026-08-08T00:00:00Z");
const WINDOW_START = new Date("2026-08-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-08T00:00:00Z");

async function makeStore(overrides: Partial<{ tier: "HOT" | "WARM" | "COOL" | "COLD" | "DORMANT" | "DISABLED"; nextCrawlAt: Date; failureStreak: number }> = {}) {
  return prisma.store.create({
    data: {
      domain: `${randomUUID().slice(0, 8)}.com`,
      platform: "SHOPIFY",
      tier: overrides.tier ?? "COLD",
      nextCrawlAt: overrides.nextCrawlAt ?? NOW,
      failureStreak: overrides.failureStreak ?? 0,
    },
  });
}

describe("getOperationalMetrics", () => {
  it("counts stores past nextCrawlAt as scheduler lag, excluding DISABLED stores (never due, by design)", async () => {
    await makeStore({ tier: "COOL", nextCrawlAt: new Date(NOW.getTime() - 60_000) }); // overdue
    await makeStore({ tier: "COOL", nextCrawlAt: new Date(NOW.getTime() + 60_000) }); // not yet due
    await makeStore({ tier: "DISABLED", nextCrawlAt: new Date(NOW.getTime() - 60_000) }); // overdue timestamp but DISABLED — never claimed

    const metrics = await getOperationalMetrics(prisma, NOW, WINDOW_START, WINDOW_END);
    expect(metrics.schedulerLagCount).toBe(1);
    expect(metrics.disabledStoreCount).toBe(1);
  });

  it("counts stores currently on a failure streak", async () => {
    await makeStore({ failureStreak: 3 });
    await makeStore({ failureStreak: 0 });

    const metrics = await getOperationalMetrics(prisma, NOW, WINDOW_START, WINDOW_END);
    expect(metrics.storesOnFailureStreak).toBe(1);
  });

  it("counts promo redemptions inside the window only", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    const promo = await prisma.promoCode.create({
      data: { code: randomUUID(), discountType: "PERCENT", discountValue: 100, validFrom: new Date("2026-01-01T00:00:00Z"), createdByUserId: user.id },
    });
    await prisma.promoRedemption.create({
      data: { promoCodeId: promo.id, userId: user.id, listPriceCents: 1900, discountCents: 1900, finalCents: 0, createdAt: new Date("2026-08-05T00:00:00Z") },
    });

    const metrics = await getOperationalMetrics(prisma, NOW, WINDOW_START, WINDOW_END);
    expect(metrics.promoRedemptionsInWindow).toBe(1);
  });
});
