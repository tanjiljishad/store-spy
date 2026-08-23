import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as signup } from "../../../app/api/auth/signup/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { verifyPassword } from "../password";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
}
if (!/test/i.test(url)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`,
  );
}

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "MarketingConversionEvent","Session","Account","User" RESTART IDENTITY CASCADE`);
  _resetRateLimitState();
});

/** Every call site defaults tosAccepted: true — the field this whole suite is NOT testing gets out of the way; the dedicated "ToS" describe block below overrides it explicitly. */
function req(body: Record<string, unknown>, ip = "203.0.113.9", cookie?: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ tosAccepted: true, ...body }),
  });
}

describe("POST /api/auth/signup", () => {
  it("creates a real user with a bcrypt hash, never the plaintext password", async () => {
    const res = await signup(req({ email: "new-user@example.com", password: "correct-password" }));
    expect(res.status).toBe(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "new-user@example.com" } });
    expect(user.passwordHash).not.toBe("correct-password");
    expect(await verifyPassword("correct-password", user.passwordHash!)).toBe(true);
    expect(user.plan).toBe("FREE");
  });

  // Milestone 11, Phase 2, invariant 5: signup must never accept a `role`
  // field — the route already picks fields explicitly (email/password/name
  // only), so this is a regression lock confirming that stays true, not a
  // behavior change.
  it("ignores a client-supplied role field — new accounts are always USER", async () => {
    const res = await signup(req({ email: "role-spoof@example.com", password: "correct-password", role: "SUPER_ADMIN" }));
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "role-spoof@example.com" } });
    expect(user.role).toBe("USER");
  });

  it("normalizes email on the way in", async () => {
    await signup(req({ email: "  Mixed.Case@Example.COM  ", password: "correct-password" }));
    const user = await prisma.user.findUnique({ where: { email: "mixed.case@example.com" } });
    expect(user).not.toBeNull();
  });

  it("rejects a duplicate email with a clean 409, not a raw DB error", async () => {
    await signup(req({ email: "dup@example.com", password: "correct-password" }));
    const res = await signup(req({ email: "DUP@example.com", password: "another-password" }, "203.0.113.10"));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("rejects a too-short password", async () => {
    const res = await signup(req({ email: "short-pw@example.com", password: "short" }));
    expect(res.status).toBe(400);
    const users = await prisma.user.count({ where: { email: "short-pw@example.com" } });
    expect(users).toBe(0);
  });

  it("rejects a common password even at 10+ characters", async () => {
    const res = await signup(req({ email: "weak-pw@example.com", password: "qwertyuiop" }));
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { email: "weak-pw@example.com" } })).toBe(0);
  });

  it("rejects a password containing the account's own email local-part", async () => {
    const res = await signup(req({ email: "distinctivename@example.com", password: "distinctivename99" }));
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { email: "distinctivename@example.com" } })).toBe(0);
  });

  it("pads both the 201 and 409 responses to the same minimum floor, closing the timing side of enumeration", async () => {
    const start1 = Date.now();
    const created = await signup(req({ email: "timing-test@example.com", password: "correct-password" }, "203.0.113.30"));
    const createdElapsed = Date.now() - start1;
    expect(created.status).toBe(201);

    const start2 = Date.now();
    const duplicate = await signup(req({ email: "timing-test@example.com", password: "another-password" }, "203.0.113.31"));
    const duplicateElapsed = Date.now() - start2;
    expect(duplicate.status).toBe(409);

    expect(createdElapsed).toBeGreaterThanOrEqual(390); // small tolerance below the 400ms floor
    expect(duplicateElapsed).toBeGreaterThanOrEqual(390);
  });

  it("rejects an implausible email", async () => {
    const res = await signup(req({ email: "not-an-email", password: "correct-password" }));
    expect(res.status).toBe(400);
  });

  it("rate limits repeated signup attempts from the same client", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) {
      last = await signup(req({ email: `rl-${i}@example.com`, password: "correct-password" }, "203.0.113.20"));
    }
    expect(last!.status).toBe(429);
  });

  // Milestone 12 §4.1.
  describe("ToS acceptance", () => {
    it("rejects signup with tosAccepted omitted", async () => {
      const res = await signup(
        new NextRequest("http://localhost/api/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.40" },
          body: JSON.stringify({ email: "no-tos@example.com", password: "correct-password" }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await prisma.user.count({ where: { email: "no-tos@example.com" } })).toBe(0);
    });

    it("rejects signup with tosAccepted: false explicitly", async () => {
      const res = await signup(req({ email: "tos-false@example.com", password: "correct-password", tosAccepted: false }));
      expect(res.status).toBe(400);
      expect(await prisma.user.count({ where: { email: "tos-false@example.com" } })).toBe(0);
    });

    it("accepts signup with tosAccepted: true", async () => {
      const res = await signup(req({ email: "tos-true@example.com", password: "correct-password" }));
      expect(res.status).toBe(201);
    });

    // §4.1 addendum: this is the ONE field DashboardLayout gates on
    // (needsConsentInterstitial()) — a credentials signup must set it
    // itself, or it would incorrectly hit the OAuth-only /welcome
    // interstitial on its very first dashboard visit.
    it("sets tosAcceptedAt to a real, current timestamp", async () => {
      const before = new Date();
      await signup(req({ email: "tos-timestamp@example.com", password: "correct-password" }));
      const after = new Date();

      const user = await prisma.user.findUniqueOrThrow({ where: { email: "tos-timestamp@example.com" } });
      expect(user.tosAcceptedAt).not.toBeNull();
      expect(user.tosAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(user.tosAcceptedAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });
  });

  // Milestone 12 §4.1: "a separate, unticked checkbox... must not be
  // bundled into ToS acceptance."
  describe("marketing consent", () => {
    it("defaults to false — marketingConsentAt/Source stay null — when the field is omitted (unticked)", async () => {
      await signup(req({ email: "no-marketing@example.com", password: "correct-password" }));
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "no-marketing@example.com" } });
      expect(user.marketingConsent).toBe(false);
      expect(user.marketingConsentAt).toBeNull();
      expect(user.marketingConsentSource).toBeNull();
    });

    it("stays false even when tosAccepted is true and marketingConsent is absent — the two are genuinely independent, not linked", async () => {
      await signup(req({ email: "tos-only@example.com", password: "correct-password", tosAccepted: true }));
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "tos-only@example.com" } });
      expect(user.marketingConsent).toBe(false);
    });

    it("records true, with a real timestamp and source, when marketingConsent: true is sent", async () => {
      const before = new Date();
      await signup(req({ email: "wants-marketing@example.com", password: "correct-password", marketingConsent: true }));
      const after = new Date();

      const user = await prisma.user.findUniqueOrThrow({ where: { email: "wants-marketing@example.com" } });
      expect(user.marketingConsent).toBe(true);
      expect(user.marketingConsentSource).toBe("signup_form");
      expect(user.marketingConsentAt).not.toBeNull();
      expect(user.marketingConsentAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(user.marketingConsentAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });

    it("a truthy but non-boolean marketingConsent value is NOT treated as consent — only a literal true counts", async () => {
      await signup(req({ email: "truthy-not-true@example.com", password: "correct-password", marketingConsent: "yes" }));
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "truthy-not-true@example.com" } });
      expect(user.marketingConsent).toBe(false);
    });
  });

  // Milestone 12 §4.2 Step 2: gated on the COOKIE consent state (the
  // banner's own cookie, read from the REQUEST's own cookie header) — a
  // legally distinct signal from the marketingConsent describe block
  // above, which is the "may we email you" checkbox. Both can vary
  // independently.
  describe("signup conversion event recording (marketing/conversion-events.ts)", () => {
    it("records one SIGNUP MarketingConversionEvent PER server-side vendor (meta, google, tiktok, linkedin, AND x) when the request's own bw-cookie-consent cookie is granted", async () => {
      const res = await signup(req({ email: "cookie-granted@example.com", password: "correct-password" }, "203.0.113.50", "bw-cookie-consent=granted"));
      expect(res.status).toBe(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { email: "cookie-granted@example.com" } });
      const events = await prisma.marketingConversionEvent.findMany({ where: { userId: user.id } });
      expect(events).toHaveLength(5);
      for (const event of events) {
        expect(event).toMatchObject({ eventType: "SIGNUP", dispatchStatus: "PENDING" });
      }
      expect(events.map((e) => e.vendor).sort()).toEqual(["google", "linkedin", "meta", "tiktok", "x"]);
    });

    it("records nothing when the cookie is denied", async () => {
      await signup(req({ email: "cookie-denied@example.com", password: "correct-password" }, "203.0.113.51", "bw-cookie-consent=denied"));
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "cookie-denied@example.com" } });
      expect(await prisma.marketingConversionEvent.count({ where: { userId: user.id } })).toBe(0);
    });

    it("records nothing when no consent cookie was ever sent (a visitor who never interacted with the banner)", async () => {
      await signup(req({ email: "cookie-unset@example.com", password: "correct-password" }, "203.0.113.52"));
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "cookie-unset@example.com" } });
      expect(await prisma.marketingConversionEvent.count({ where: { userId: user.id } })).toBe(0);
    });

    it("is independent of marketingConsent (the email checkbox) — cookie-granted but marketingConsent:false still records every vendor's conversion event", async () => {
      await signup(
        req({ email: "cookie-yes-email-no@example.com", password: "correct-password", marketingConsent: false }, "203.0.113.53", "bw-cookie-consent=granted"),
      );
      const user = await prisma.user.findUniqueOrThrow({ where: { email: "cookie-yes-email-no@example.com" } });
      expect(user.marketingConsent).toBe(false);
      expect(await prisma.marketingConversionEvent.count({ where: { userId: user.id } })).toBe(5);
    });
  });
});
