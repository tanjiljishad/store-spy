import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchPendingConversionEvents, recordSignupConversionEvents } from "../conversion-events";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "MarketingConversionEvent" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

async function makeUser() {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
}

describe("recordSignupConversionEvents", () => {
  it("writes one SIGNUP row per server-side vendor (meta, google, tiktok, linkedin, AND x) when cookie consent is granted", async () => {
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const rows = await prisma.marketingConversionEvent.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row).toMatchObject({ eventType: "SIGNUP", dispatchStatus: "PENDING" });
    }
    expect(rows.map((r) => r.vendor).sort()).toEqual(["google", "linkedin", "meta", "tiktok", "x"]);
  });

  it("writes nothing when cookie consent is denied", async () => {
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "denied");
    expect(await prisma.marketingConversionEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  it("writes nothing when cookie consent is unset (the default for a silent visitor)", async () => {
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "unset");
    expect(await prisma.marketingConversionEvent.count({ where: { userId: user.id } })).toBe(0);
  });

  it("never stores any PII beyond the user id — no email, no name — in either vendor's row", async () => {
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");
    const rows = await prisma.marketingConversionEvent.findMany({ where: { userId: user.id } });
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(user.email);
    }
  });
});

describe("dispatchPendingConversionEvents", () => {
  const originalEnv = {
    META_CONVERSIONS_API_ACCESS_TOKEN: process.env.META_CONVERSIONS_API_ACCESS_TOKEN,
    GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET: process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET,
    NEXT_PUBLIC_GA4_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID,
    TIKTOK_EVENTS_API_ACCESS_TOKEN: process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN,
    NEXT_PUBLIC_TIKTOK_PIXEL_ID: process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID,
    LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN: process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN,
    NEXT_PUBLIC_LINKEDIN_PARTNER_ID: process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID,
    X_CONVERSIONS_API_ACCESS_TOKEN: process.env.X_CONVERSIONS_API_ACCESS_TOKEN,
    X_PIXEL_ID: process.env.X_PIXEL_ID,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => {
    delete process.env.META_CONVERSIONS_API_ACCESS_TOKEN;
    delete process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET;
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    delete process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN;
    delete process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID;
    delete process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN;
    delete process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID;
    delete process.env.X_CONVERSIONS_API_ACCESS_TOKEN;
    delete process.env.X_PIXEL_ID;
  });

  it("marks pending Meta, Google, TikTok, LinkedIn, AND X events SKIPPED_NO_CREDENTIAL — the real, expected state until §4.3 ships real credentials", async () => {
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const result = await dispatchPendingConversionEvents(prisma);
    expect(result).toEqual({ dispatched: 0, skipped: 5, failed: 0 });

    const rows = await prisma.marketingConversionEvent.findMany({ where: { userId: user.id } });
    for (const row of rows) {
      expect(row.dispatchStatus).toBe("SKIPPED_NO_CREDENTIAL");
      expect(row.dispatchedAt).toBeNull(); // SKIPPED is not the same as DISPATCHED
    }
  });

  it("does not re-process an already-dispatched (non-PENDING) row on a later tick", async () => {
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");
    await dispatchPendingConversionEvents(prisma); // first tick: PENDING -> SKIPPED_NO_CREDENTIAL

    const second = await dispatchPendingConversionEvents(prisma);
    expect(second).toEqual({ dispatched: 0, skipped: 0, failed: 0 }); // nothing left to process
  });

  it("marks a row for an unrecognized vendor FAILED, with a real error, rather than crashing the whole batch", async () => {
    const user = await makeUser();
    await prisma.marketingConversionEvent.create({ data: { eventType: "SIGNUP", vendor: "not-a-real-vendor", userId: user.id } });

    const result = await dispatchPendingConversionEvents(prisma);
    expect(result).toEqual({ dispatched: 0, skipped: 0, failed: 1 });

    const row = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.dispatchStatus).toBe("FAILED");
    expect(row.dispatchError).toContain("not-a-real-vendor");
  });

  it("if isMetaConversionsApiConfigured() were somehow true (no real credential exists this phase), dispatch throws into the row as FAILED rather than crashing the batch or silently succeeding", async () => {
    process.env.META_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const result = await dispatchPendingConversionEvents(prisma);
    // Meta throws into FAILED; the other four still have no credential, so they skip — proves each vendor dispatches independently, one's fake config doesn't affect the others.
    expect(result).toEqual({ dispatched: 0, skipped: 4, failed: 1 });
    const metaRow = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor: "meta" } });
    expect(metaRow.dispatchStatus).toBe("FAILED");
    expect(metaRow.dispatchError).toContain("not implemented yet");
    for (const vendor of ["google", "tiktok", "linkedin", "x"]) {
      const row = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor } });
      expect(row.dispatchStatus).toBe("SKIPPED_NO_CREDENTIAL");
    }
  });

  it("if isGoogleMeasurementProtocolConfigured() were somehow true (no real credential exists this phase), dispatch throws into the row as FAILED rather than crashing the batch or silently succeeding", async () => {
    process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET = "fake-secret-for-this-test-only";
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const result = await dispatchPendingConversionEvents(prisma);
    expect(result).toEqual({ dispatched: 0, skipped: 4, failed: 1 });
    const googleRow = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor: "google" } });
    expect(googleRow.dispatchStatus).toBe("FAILED");
    expect(googleRow.dispatchError).toContain("not implemented yet");
    for (const vendor of ["meta", "tiktok", "linkedin", "x"]) {
      const row = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor } });
      expect(row.dispatchStatus).toBe("SKIPPED_NO_CREDENTIAL");
    }
  });

  it("if isTikTokEventsApiConfigured() were somehow true (no real credential exists this phase), dispatch throws into the row as FAILED rather than crashing the batch or silently succeeding", async () => {
    process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
    process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const result = await dispatchPendingConversionEvents(prisma);
    expect(result).toEqual({ dispatched: 0, skipped: 4, failed: 1 });
    const tiktokRow = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor: "tiktok" } });
    expect(tiktokRow.dispatchStatus).toBe("FAILED");
    expect(tiktokRow.dispatchError).toContain("not implemented yet");
    for (const vendor of ["meta", "google", "linkedin", "x"]) {
      const row = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor } });
      expect(row.dispatchStatus).toBe("SKIPPED_NO_CREDENTIAL");
    }
  });

  it("if isLinkedInConversionsApiConfigured() were somehow true (no real credential exists this phase), dispatch throws into the row as FAILED rather than crashing the batch or silently succeeding", async () => {
    process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
    process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const result = await dispatchPendingConversionEvents(prisma);
    expect(result).toEqual({ dispatched: 0, skipped: 4, failed: 1 });
    const linkedinRow = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor: "linkedin" } });
    expect(linkedinRow.dispatchStatus).toBe("FAILED");
    expect(linkedinRow.dispatchError).toContain("not implemented yet");
    for (const vendor of ["meta", "google", "tiktok", "x"]) {
      const row = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor } });
      expect(row.dispatchStatus).toBe("SKIPPED_NO_CREDENTIAL");
    }
  });

  it("if isXConversionsApiConfigured() were somehow true (no real credential exists this phase), dispatch throws into the row as FAILED rather than crashing the batch or silently succeeding", async () => {
    process.env.X_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
    process.env.X_PIXEL_ID = "o1a2b3";
    const user = await makeUser();
    await recordSignupConversionEvents(prisma, user.id, "granted");

    const result = await dispatchPendingConversionEvents(prisma);
    expect(result).toEqual({ dispatched: 0, skipped: 4, failed: 1 });
    const xRow = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor: "x" } });
    expect(xRow.dispatchStatus).toBe("FAILED");
    expect(xRow.dispatchError).toContain("not implemented yet");
    for (const vendor of ["meta", "google", "tiktok", "linkedin"]) {
      const row = await prisma.marketingConversionEvent.findFirstOrThrow({ where: { userId: user.id, vendor } });
      expect(row.dispatchStatus).toBe("SKIPPED_NO_CREDENTIAL");
    }
  });
});
