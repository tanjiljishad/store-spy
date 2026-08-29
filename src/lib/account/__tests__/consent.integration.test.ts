import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { needsConsentInterstitial, recordOAuthWelcomeConsent } from "../consent";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "User" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

/** No passwordHash, no tosAcceptedAt — the shape B2 step 2·A's OAuth adapter creates for a first OAuth sign-in. */
async function makeOAuthShapedUser() {
  return makeStoreSpyUser(prisma, { passwordHash: null, tosAcceptedAt: null });
}

describe("needsConsentInterstitial", () => {
  it("is true for a freshly OAuth-created account (tosAcceptedAt never set)", async () => {
    const user = await makeOAuthShapedUser();
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(true);
  });

  it("is false once tosAcceptedAt is set (credentials signup, or a completed interstitial)", async () => {
    const user = await makeStoreSpyUser(prisma, { tosAcceptedAt: new Date() });
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(false);
  });

  it("is false for a nonexistent user — nothing left to gate", async () => {
    expect(await needsConsentInterstitial(prisma, "does-not-exist")).toBe(false);
  });
});

describe("recordOAuthWelcomeConsent", () => {
  it("sets tosAcceptedAt and does NOT grant marketing consent when marketingConsent is false", async () => {
    const user = await makeOAuthShapedUser();
    const now = new Date("2026-08-23T00:00:00Z");

    await recordOAuthWelcomeConsent(prisma, user.id, { marketingConsent: false }, now);

    expect((await prisma.cpUser.findUniqueOrThrow({ where: { id: user.id } })).tosAcceptedAt).toEqual(now);
    const mc = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(mc.consent).toBe(false);
    expect(mc.consentAt).toBeNull();
    expect(mc.consentSource).toBeNull();
  });

  it("sets tosAcceptedAt AND grants marketing consent, with the oauth_welcome_interstitial source, when marketingConsent is true", async () => {
    const user = await makeOAuthShapedUser();
    const now = new Date("2026-08-23T00:00:00Z");

    await recordOAuthWelcomeConsent(prisma, user.id, { marketingConsent: true }, now);

    expect((await prisma.cpUser.findUniqueOrThrow({ where: { id: user.id } })).tosAcceptedAt).toEqual(now);
    const mc = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(mc.consent).toBe(true);
    expect(mc.consentAt).toEqual(now);
    expect(mc.consentSource).toBe("oauth_welcome_interstitial");
  });

  it("after recording, needsConsentInterstitial flips to false for the same user", async () => {
    const user = await makeOAuthShapedUser();
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(true);
    await recordOAuthWelcomeConsent(prisma, user.id, { marketingConsent: false });
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(false);
  });
});
