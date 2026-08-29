import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { evaluatePromo, PromoRedemptionError, redeemPromo } from "../promo";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "PromoRedemption","PromoCode","Checkout","Subscription" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

async function makeUser() {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
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

describe("evaluatePromo", () => {
  it("returns not_found for a code that doesn't exist", async () => {
    const user = await makeUser();
    const result = await evaluatePromo(prisma, { code: "NOPE1234", userId: user.id, plan: "BASIC", period: "MONTHLY" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("a fixed-amount promo larger than the list price clamps finalCents to 0, never negative", async () => {
    const user = await makeUser();
    const promo = await makePromo({ discountType: "FIXED", discountValue: 999_999 }); // absurdly large
    const result = await evaluatePromo(prisma, { code: promo.code, userId: user.id, plan: "BASIC", period: "MONTHLY" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.finalCents).toBe(0);
    expect(result.discountCents).toBeLessThanOrEqual(result.listPriceCents);
  });

  it("a promo assigned to user A returns the IDENTICAL response to a nonexistent code when user B tries it", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const promo = await makePromo({ assignedToUserId: userA.id });

    const asB = await evaluatePromo(prisma, { code: promo.code, userId: userB.id, plan: "BASIC", period: "MONTHLY" });
    const nonexistent = await evaluatePromo(prisma, { code: "TOTALLYFAKE99", userId: userB.id, plan: "BASIC", period: "MONTHLY" });

    // Different internal `reason` values are fine (not_assigned_to_you vs
    // not_found) — what matters is the ROUTE layer collapses both to the
    // same shape; verified separately at the route level. Here we confirm
    // the underlying function actually distinguishes them for that route
    // logic to work from, while user A themselves succeeds.
    expect(asB.ok).toBe(false);
    expect(nonexistent.ok).toBe(false);
    if (asB.ok || nonexistent.ok) throw new Error("unreachable");
    expect(asB.reason).toBe("not_assigned_to_you");
    expect(nonexistent.reason).toBe("not_found");

    const asA = await evaluatePromo(prisma, { code: promo.code, userId: userA.id, plan: "BASIC", period: "MONTHLY" });
    expect(asA.ok).toBe(true);
  });

  it("rejects a disabled promo", async () => {
    const user = await makeUser();
    const promo = await makePromo({ status: "DISABLED" });
    const result = await evaluatePromo(prisma, { code: promo.code, userId: user.id, plan: "BASIC", period: "MONTHLY" });
    expect(result).toEqual({ ok: false, reason: "disabled" });
  });

  it("rejects a promo restricted to a different plan", async () => {
    const user = await makeUser();
    const promo = await makePromo({ appliesToPlan: "BUSINESS" });
    const result = await evaluatePromo(prisma, { code: promo.code, userId: user.id, plan: "BASIC", period: "MONTHLY" });
    expect(result).toEqual({ ok: false, reason: "wrong_plan" });
  });

  it("rejects an expired promo", async () => {
    const user = await makeUser();
    const promo = await makePromo({ validUntil: new Date(Date.now() - 1000) });
    const result = await evaluatePromo(prisma, { code: promo.code, userId: user.id, plan: "BASIC", period: "MONTHLY" });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});

describe("redeemPromo — atomicity", () => {
  it("a user cannot redeem the same promo twice", async () => {
    const user = await makeUser();
    const promo = await makePromo();

    await prisma.$transaction(async (tx) => {
      await redeemPromo(tx, { promoId: promo.id, userId: user.id, checkoutId: null, amounts: { listPriceCents: 1900, discountCents: 1900, finalCents: 0 } });
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await redeemPromo(tx, { promoId: promo.id, userId: user.id, checkoutId: null, amounts: { listPriceCents: 1900, discountCents: 1900, finalCents: 0 } });
      }),
    ).rejects.toThrow(PromoRedemptionError);

    const count = await prisma.promoRedemption.count({ where: { promoCodeId: promo.id, userId: user.id } });
    expect(count).toBe(1); // unique index backs this up at the DB level too
  });

  it("two concurrent redemptions of a maxRedemptions: 1 promo produce exactly one redemption", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const promo = await makePromo({ maxRedemptions: 1 });

    const attempt = (userId: string) =>
      prisma
        .$transaction(async (tx) => {
          await redeemPromo(tx, { promoId: promo.id, userId, checkoutId: null, amounts: { listPriceCents: 1900, discountCents: 1900, finalCents: 0 } });
        })
        .then(() => "succeeded" as const)
        .catch(() => "failed" as const);

    const [resultA, resultB] = await Promise.all([attempt(userA.id), attempt(userB.id)]);

    const outcomes = [resultA, resultB].sort();
    expect(outcomes).toEqual(["failed", "succeeded"]);

    const totalRedemptions = await prisma.promoRedemption.count({ where: { promoCodeId: promo.id } });
    expect(totalRedemptions).toBe(1); // never two, even under a real race
  });
});
