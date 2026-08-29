import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expirePendingCheckouts, processCheckout } from "../checkout";
import { listPriceCents } from "../pricing";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","PromoRedemption","PromoCode","Checkout","Subscription" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

async function makeUser() {
  return makeStoreSpyUser(prisma, { plan: "FREE" });
}
/** The account's current tier, from the control-plane subscription (B2 2·B — plan is no longer a store_spy.User column). */
async function currentPlan(userId: string): Promise<string> {
  const sub = await prisma.cpSubscription.findFirstOrThrow({
    where: { accountId: `acct_${userId}`, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" },
    select: { planSlug: true },
  });
  return sub.planSlug!;
}
async function makePromo(overrides: Partial<Parameters<typeof prisma.promoCode.create>[0]["data"]> = {}) {
  return prisma.promoCode.create({
    data: {
      code: `TEST${randomUUID().slice(0, 8).toUpperCase()}`,
      discountType: "PERCENT",
      discountValue: 100,
      perUserLimit: 1,
      validFrom: new Date(Date.now() - 1000),
      createdByUserId: "test-admin",
      ...overrides,
    },
  });
}

describe("processCheckout — the 100%-off path is fully functional with zero payment-provider involvement", () => {
  it("grants the plan, redeems the promo, creates a Subscription, and writes exactly one audit row", async () => {
    const user = await makeUser();
    const promo = await makePromo();

    const result = await processCheckout(prisma, { userId: user.id, plan: "BASIC", period: "MONTHLY", code: promo.code });

    expect(result).toEqual({ outcome: "completed_free", plan: "BASIC" });

    expect(await currentPlan(user.id)).toBe("BASIC");

    const redemption = await prisma.promoRedemption.findFirstOrThrow({ where: { promoCodeId: promo.id, userId: user.id } });
    expect(redemption.finalCents).toBe(0);

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    expect(subscription).toMatchObject({ plan: "BASIC", source: "PROMO", status: "ACTIVE" });

    const auditRows = await prisma.adminAuditLog.count({ where: { targetId: user.id, action: "checkout.completed_free" } });
    expect(auditRows).toBe(1);
  });

  it("a durationDays promo grants a Subscription with a real expiresAt, not perpetual", async () => {
    const user = await makeUser();
    const promo = await makePromo({ durationDays: 90 });

    await processCheckout(prisma, { userId: user.id, plan: "BASIC", period: "MONTHLY", code: promo.code });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    expect(subscription.expiresAt).not.toBeNull();
    const daysUntilExpiry = Math.round((subscription.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(daysUntilExpiry).toBeGreaterThanOrEqual(89);
    expect(daysUntilExpiry).toBeLessThanOrEqual(90);
  });

  it("a promo with no durationDays grants a perpetual (null-expiry) Subscription — an explicit admin choice, not a default", async () => {
    const user = await makeUser();
    const promo = await makePromo({ durationDays: null });

    await processCheckout(prisma, { userId: user.id, plan: "BASIC", period: "MONTHLY", code: promo.code });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    expect(subscription.expiresAt).toBeNull();
  });

  it("rejects an invalid promo code rather than silently charging full price", async () => {
    const user = await makeUser();
    const result = await processCheckout(prisma, { userId: user.id, plan: "BASIC", period: "MONTHLY", code: "TOTALLYFAKE" });
    expect(result).toEqual({ outcome: "invalid_promo" });

    expect(await currentPlan(user.id)).toBe("FREE"); // unchanged
  });

  it("FREE cannot be purchased", async () => {
    const user = await makeUser();
    const result = await processCheckout(prisma, { userId: user.id, plan: "FREE", period: "MONTHLY" });
    expect(result).toEqual({ outcome: "plan_not_purchasable" });
  });
});

describe("processCheckout — no-provider (finalCents > 0) path", () => {
  it("creates a PENDING checkout, does NOT redeem the promo, and does NOT change the plan", async () => {
    const user = await makeUser();
    const promo = await makePromo({ discountType: "PERCENT", discountValue: 50 }); // 50% off, still > 0

    const result = await processCheckout(prisma, { userId: user.id, plan: "BASIC", period: "MONTHLY", code: promo.code });

    expect(result.outcome).toBe("pending");
    if (result.outcome !== "pending") throw new Error("unreachable");
    expect(result.finalCents).toBe(Math.floor(listPriceCents("BASIC", "MONTHLY") / 2));

    const checkout = await prisma.checkout.findUniqueOrThrow({ where: { id: result.checkoutId } });
    expect(checkout.status).toBe("PENDING");

    const redemptionCount = await prisma.promoRedemption.count({ where: { promoCodeId: promo.id } });
    expect(redemptionCount).toBe(0); // never redeemed until payment confirms

    expect(await currentPlan(user.id)).toBe("FREE"); // unchanged
  });

  it("no-code checkout at full price also creates a PENDING checkout with the full list price", async () => {
    const user = await makeUser();
    const result = await processCheckout(prisma, { userId: user.id, plan: "BASIC", period: "MONTHLY" });
    expect(result.outcome).toBe("pending");
    if (result.outcome !== "pending") throw new Error("unreachable");
    expect(result.finalCents).toBe(listPriceCents("BASIC", "MONTHLY"));
  });
});

describe("expirePendingCheckouts", () => {
  it("expires a PENDING checkout older than 1 hour", async () => {
    const user = await makeUser();
    const old = await prisma.checkout.create({
      data: {
        userId: user.id,
        plan: "BASIC",
        period: "MONTHLY",
        listPriceCents: 1900,
        discountCents: 0,
        finalCents: 1900,
        status: "PENDING",
        createdAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
    });
    const recent = await prisma.checkout.create({
      data: { userId: user.id, plan: "BASIC", period: "MONTHLY", listPriceCents: 1900, discountCents: 0, finalCents: 1900, status: "PENDING" },
    });

    const result = await expirePendingCheckouts(prisma);
    expect(result.expiredCount).toBe(1);

    expect((await prisma.checkout.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("EXPIRED");
    expect((await prisma.checkout.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe("PENDING");
  });
});
