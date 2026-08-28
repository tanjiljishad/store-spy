import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { processCheckout } from "../../billing/checkout";
import { expireDueSubscriptions } from "../../billing/subscription-sweep";
import { setUserPlan } from "../../admin/users-service";
import { planParityMismatches } from "../plan-parity";
import { resetControlPlane } from "../../test-support/store-spy-user";
import { _resetRateLimitState } from "../../security/rate-limit";

/**
 * B2 step 2·A: every plan-writing path now writes BOTH `User.plan` and the
 * control plane. This exercises each of them and asserts the two stay in
 * sync — the same comparison `npm run verify:b2-step1` runs, as a test.
 */

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run via `npm run test:integration` against the test database.");

const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "MarketingConversionEvent","AdminAuditLog","PromoRedemption","PromoCode","Checkout","Subscription","Watchlist","Store","Session","Account","User" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
  _resetRateLimitState();
});

async function assertParity(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, plan: true, freeTrialEndsAt: true } });
  const mismatches = await planParityMismatches(prisma, u);
  expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
}

async function signupUser(email: string): Promise<string> {
  const req = new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify({ email, password: "a-good-long-password", tosAccepted: true }),
  });
  const res = await signup(req);
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

async function make100OffPromo(): Promise<string> {
  const p = await prisma.promoCode.create({
    data: {
      code: `FREE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      discountType: "PERCENT",
      discountValue: 100,
      perUserLimit: 1,
      validFrom: new Date(Date.now() - 60_000),
      status: "ACTIVE",
      createdByUserId: "seed",
      durationDays: 90,
    },
  });
  return p.code;
}

describe("B2 2·A dual-write parity", () => {
  it("signup: a fresh account's control plane matches plan-limits.ts (FREE)", async () => {
    const id = await signupUser("dw-signup@test.local");
    await assertParity(id);
  });

  it("checkout (100%-off promo) FREE -> BASIC: parity holds, with the real expiry", async () => {
    const id = await signupUser("dw-checkout@test.local");
    const code = await make100OffPromo();
    const out = await processCheckout(prisma, { userId: id, plan: "BASIC", period: "MONTHLY", code });
    expect(out.outcome).toBe("completed_free");
    await assertParity(id);

    // and the paid subscription's period_end tracks store_spy.Subscription.expiresAt
    const [ss, cp] = await Promise.all([
      prisma.subscription.findFirstOrThrow({ where: { userId: id, status: "ACTIVE" }, select: { expiresAt: true } }),
      prisma.cpSubscription.findUniqueOrThrow({ where: { id: `sub_${id}` }, select: { periodEnd: true } }),
    ]);
    expect(cp.periodEnd?.getTime()).toBe(ss.expiresAt?.getTime());
  });

  it("admin setUserPlan FREE -> BUSINESS -> FREE: parity holds at each step", async () => {
    const id = await signupUser("dw-admin@test.local");
    await setUserPlan(prisma, id, "BUSINESS");
    await assertParity(id);
    await setUserPlan(prisma, id, "FREE");
    await assertParity(id);
  });

  it("subscription sweep downgrade BASIC -> FREE: parity holds after the sweep", async () => {
    const id = await signupUser("dw-sweep@test.local");
    await setUserPlan(prisma, id, "BASIC");
    // a store_spy.Subscription that's already due
    await prisma.subscription.create({
      data: { userId: id, plan: "BASIC", source: "PROMO", status: "ACTIVE", expiresAt: new Date(Date.now() - 60_000) },
    });
    const res = await expireDueSubscriptions(prisma);
    expect(res.expiredCount).toBe(1);

    const after = await prisma.user.findUniqueOrThrow({ where: { id }, select: { plan: true } });
    expect(after.plan).toBe("FREE");
    await assertParity(id);
  });
});
