import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { exportOwnAccountData } from "../export";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Checkout","Subscription","AnalysisUsage","Watchlist","Session","Account","Store","User" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

async function makeUser(overrides: Partial<{ marketingConsent: boolean; passwordHash: string }> = {}) {
  return makeStoreSpyUser(prisma, {
    passwordHash: overrides.passwordHash ?? "bcrypt$fake$hash",
    marketingConsent: overrides.marketingConsent ?? false,
  });
}
async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}

describe("exportOwnAccountData", () => {
  it("returns null for a nonexistent user", async () => {
    expect(await exportOwnAccountData(prisma, "does-not-exist")).toBeNull();
  });

  it("never includes passwordHash anywhere in the export", async () => {
    const user = await makeUser({ passwordHash: "bcrypt$real$secrethash" });
    const data = await exportOwnAccountData(prisma, user.id);
    expect(JSON.stringify(data)).not.toContain("secrethash");
    expect(data!.profile).not.toHaveProperty("passwordHash");
  });

  it("includes the real marketing consent fields", async () => {
    const consentedAt = new Date("2026-08-01T00:00:00Z");
    const user = await makeStoreSpyUser(prisma, { marketingConsent: true });
    // exact historical timestamp/source this test asserts on — set on
    // store_spy.MarketingConsent, the table exportOwnAccountData reads (B2 2·B).
    await prisma.marketingConsent.update({
      where: { userId: user.id },
      data: { consentAt: consentedAt, consentSource: "signup_form" },
    });
    const data = await exportOwnAccountData(prisma, user.id);
    expect(data!.profile.marketingConsent).toBe(true);
    expect(data!.profile.marketingConsentAt).toBe(consentedAt.toISOString());
    expect(data!.profile.marketingConsentSource).toBe("signup_form");
  });

  it("includes the user's own watchlists, analysis usage, subscriptions, checkouts, and promo redemptions — never someone else's", async () => {
    const user = await makeUser();
    const otherUser = await makeUser();
    const store = await makeStore();

    await prisma.watchlist.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.watchlist.create({ data: { userId: otherUser.id, storeId: store.id } });
    await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "BASIC", source: "PROVIDER", status: "ACTIVE" } });
    await prisma.checkout.create({ data: { userId: user.id, plan: "BASIC", period: "MONTHLY", listPriceCents: 1900, discountCents: 0, finalCents: 1900, status: "COMPLETED" } });

    const data = await exportOwnAccountData(prisma, user.id);
    expect(data!.watchlists).toHaveLength(1);
    expect(data!.watchlists[0].storeId).toBe(store.id);
    expect(data!.analysisUsage).toHaveLength(1);
    expect(data!.subscriptions).toHaveLength(1);
    expect(data!.subscriptions[0].plan).toBe("BASIC");
    expect(data!.checkouts).toHaveLength(1);
  });
});
