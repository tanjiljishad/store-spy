import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { needsConsentInterstitial, recordOAuthWelcomeConsent } from "../consent";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "User" RESTART IDENTITY CASCADE`));

/** No passwordHash — exactly the shape Auth.js's Prisma adapter creates for a first OAuth sign-in. */
async function makeOAuthShapedUser() {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com` } });
}

describe("needsConsentInterstitial", () => {
  it("is true for a freshly OAuth-created account (tosAcceptedAt never set)", async () => {
    const user = await makeOAuthShapedUser();
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(true);
  });

  it("is false once tosAcceptedAt is set (credentials signup, or a completed interstitial)", async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, tosAcceptedAt: new Date() } });
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

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.tosAcceptedAt).toEqual(now);
    expect(updated.marketingConsent).toBe(false);
    expect(updated.marketingConsentAt).toBeNull();
    expect(updated.marketingConsentSource).toBeNull();
  });

  it("sets tosAcceptedAt AND grants marketing consent, with the oauth_welcome_interstitial source, when marketingConsent is true", async () => {
    const user = await makeOAuthShapedUser();
    const now = new Date("2026-08-23T00:00:00Z");

    await recordOAuthWelcomeConsent(prisma, user.id, { marketingConsent: true }, now);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.tosAcceptedAt).toEqual(now);
    expect(updated.marketingConsent).toBe(true);
    expect(updated.marketingConsentAt).toEqual(now);
    expect(updated.marketingConsentSource).toBe("oauth_welcome_interstitial");
  });

  it("after recording, needsConsentInterstitial flips to false for the same user", async () => {
    const user = await makeOAuthShapedUser();
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(true);
    await recordOAuthWelcomeConsent(prisma, user.id, { marketingConsent: false });
    expect(await needsConsentInterstitial(prisma, user.id)).toBe(false);
  });
});
