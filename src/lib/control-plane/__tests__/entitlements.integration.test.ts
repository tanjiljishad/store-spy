import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resolveEntitlement } from "../entitlements";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}).`);
}

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  // control_plane isn't in search_path (store_spy,public) — qualify it.
  // `products` is left alone: it's seeded by the migration and every
  // subscription fixture below points its product_id at the seeded store-spy row.
  await prisma.$executeRawUnsafe(
    `TRUNCATE "control_plane"."entitlements","control_plane"."subscriptions","control_plane"."accounts" RESTART IDENTITY CASCADE`,
  );
});

const STORE_SPY_PRODUCT_ID = "prod_store_spy"; // seeded by migration 20260828120000
const FEATURE = "store_spy.analysis.run";

async function makeAccount() {
  return prisma.cpAccount.create({ data: { billingEmail: `${randomUUID().slice(0, 8)}@example.com` } });
}

async function makeSubscription(
  accountId: string,
  opts: { status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED"; periodEnd: Date | null; createdAt?: Date },
) {
  return prisma.cpSubscription.create({
    data: {
      accountId,
      productId: STORE_SPY_PRODUCT_ID,
      status: opts.status,
      periodEnd: opts.periodEnd,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

async function grant(subscriptionId: string, featureKey: string, quota: number | null) {
  return prisma.cpEntitlement.create({ data: { subscriptionId, featureKey, quota } });
}

const future = () => new Date(Date.now() + 7 * 24 * 60 * 60_000);
const past = () => new Date(Date.now() - 60_000);

describe("resolveEntitlement — subscription status & expiry only (B3, revised contract)", () => {
  it("no subscription / no entitlement row at all → no_entitlement, not allowed, quota null", async () => {
    const acc = await makeAccount();
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
      allowed: false,
      quota: null,
      reason: "no_entitlement",
    });
  });

  it("TRIALING with a future period_end → ok, allowed, quota passed straight through", async () => {
    const acc = await makeAccount();
    const sub = await makeSubscription(acc.id, { status: "TRIALING", periodEnd: future() });
    await grant(sub.id, FEATURE, 10);
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
      allowed: true,
      quota: 10,
      reason: "ok",
    });
  });

  it("TRIALING past its period_end → trial_expired, not allowed, quota still reported", async () => {
    const acc = await makeAccount();
    const sub = await makeSubscription(acc.id, { status: "TRIALING", periodEnd: past() });
    await grant(sub.id, FEATURE, 10);
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
      allowed: false,
      quota: 10,
      reason: "trial_expired",
    });
  });

  it("ACTIVE with a null period_end (perpetual) → ok, allowed", async () => {
    const acc = await makeAccount();
    const sub = await makeSubscription(acc.id, { status: "ACTIVE", periodEnd: null });
    await grant(sub.id, FEATURE, 50);
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toMatchObject({
      allowed: true,
      quota: 50,
      reason: "ok",
    });
  });

  it("ACTIVE but past period_end (sweep hasn't caught it) → subscription_inactive, not trial_expired", async () => {
    const acc = await makeAccount();
    const sub = await makeSubscription(acc.id, { status: "ACTIVE", periodEnd: past() });
    await grant(sub.id, FEATURE, 50);
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
      allowed: false,
      quota: 50,
      reason: "subscription_inactive",
    });
  });

  it.each(["PAST_DUE", "CANCELED", "EXPIRED"] as const)(
    "%s subscription → subscription_inactive regardless of period_end",
    async (status) => {
      const acc = await makeAccount();
      const sub = await makeSubscription(acc.id, { status, periodEnd: future() });
      await grant(sub.id, FEATURE, 50);
      expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
        allowed: false,
        quota: 50,
        reason: "subscription_inactive",
      });
    },
  );

  it("quota null (a boolean capability like store_spy.intelligence.advanced) → allowed, quota null", async () => {
    const acc = await makeAccount();
    const sub = await makeSubscription(acc.id, { status: "ACTIVE", periodEnd: null });
    await grant(sub.id, "store_spy.intelligence.advanced", null);
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: "store_spy.intelligence.advanced" })).toEqual({
      allowed: true,
      quota: null,
      reason: "ok",
    });
  });

  it("an account with a lapsed trial AND a newer active paid plan for the same feature → resolves to the active one (ok)", async () => {
    const acc = await makeAccount();
    const oldTrial = await makeSubscription(acc.id, {
      status: "TRIALING",
      periodEnd: past(),
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60_000),
    });
    await grant(oldTrial.id, FEATURE, 10);
    const paid = await makeSubscription(acc.id, { status: "ACTIVE", periodEnd: null });
    await grant(paid.id, FEATURE, 50);

    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
      allowed: true,
      quota: 50,
      reason: "ok",
    });
  });

  it("is scoped to the asking account — another account's entitlement for the same key is invisible", async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount();
    const theirSub = await makeSubscription(theirs.id, { status: "ACTIVE", periodEnd: null });
    await grant(theirSub.id, FEATURE, 50);

    expect(await resolveEntitlement(prisma, { accountId: mine.id, featureKey: FEATURE })).toEqual({
      allowed: false,
      quota: null,
      reason: "no_entitlement",
    });
  });

  it("an unrelated feature_key on a valid subscription → no_entitlement for the asked key", async () => {
    const acc = await makeAccount();
    const sub = await makeSubscription(acc.id, { status: "ACTIVE", periodEnd: null });
    await grant(sub.id, "store_spy.monitoring.slots", 20);
    expect(await resolveEntitlement(prisma, { accountId: acc.id, featureKey: FEATURE })).toEqual({
      allowed: false,
      quota: null,
      reason: "no_entitlement",
    });
  });
});
