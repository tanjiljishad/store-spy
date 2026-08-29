import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { grantMarketingConsent, revokeMarketingConsent, SIGNUP_FORM_CONSENT_SOURCE, OAUTH_WELCOME_CONSENT_SOURCE } from "../consent";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetControlPlane(prisma);
});

const makeUser = () => makeStoreSpyUser(prisma);

describe("grantMarketingConsent / revokeMarketingConsent", () => {
  it("grant sets consent true with a real timestamp and the given source", async () => {
    const user = await makeUser();
    const now = new Date("2026-08-22T00:00:00Z");

    await grantMarketingConsent(prisma, user.id, SIGNUP_FORM_CONSENT_SOURCE, now);

    const updated = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(updated.consent).toBe(true);
    expect(updated.consentAt).toEqual(now);
    expect(updated.consentSource).toBe("signup_form");
  });

  it("records the OAuth-interstitial source distinctly from the signup-form source", async () => {
    const user = await makeUser();
    await grantMarketingConsent(prisma, user.id, OAUTH_WELCOME_CONSENT_SOURCE);
    const updated = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(updated.consentSource).toBe("oauth_welcome_interstitial");
  });

  it("revoke flips consent to false but preserves the original marketingConsentAt/Source as history", async () => {
    const user = await makeUser();
    const grantedAt = new Date("2026-08-01T00:00:00Z");
    await grantMarketingConsent(prisma, user.id, SIGNUP_FORM_CONSENT_SOURCE, grantedAt);

    await revokeMarketingConsent(prisma, user.id);

    const updated = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(updated.consent).toBe(false);
    expect(updated.consentAt).toEqual(grantedAt); // NOT cleared — the historical grant record survives
    expect(updated.consentSource).toBe("signup_form");
  });

  it("revoke is idempotent — revoking a user who never consented is a harmless no-op", async () => {
    const user = await makeUser();
    await revokeMarketingConsent(prisma, user.id);
    const updated = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(updated.consent).toBe(false);
    expect(updated.consentAt).toBeNull();
  });
});
