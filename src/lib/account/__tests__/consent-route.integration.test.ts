import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {
    constructor() {
      super("Unauthorized");
      this.name = "UnauthorizedError";
    }
  }
  class ForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  }
  const getCurrentUser = vi.fn();
  const requireUser = async () => {
    const user = await getCurrentUser();
    if (!user) throw new UnauthorizedError();
    return user;
  };
  return { getCurrentUser, requireUser, UnauthorizedError, ForbiddenError };
});

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { POST as postConsent } from "../../../app/api/account/consent/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account","User" RESTART IDENTITY CASCADE`);
  _resetRateLimitState();
  vi.mocked(getCurrentUser).mockReset();
  await resetControlPlane(prisma);
});

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/consent", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.11", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function makeOAuthShapedUser() {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
}

describe("POST /api/account/consent", () => {
  it("401s an anonymous caller", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await postConsent(req({ tosAccepted: true }));
    expect(res.status).toBe(401);
  });

  it("400s when tosAccepted is missing or false — never sets tosAcceptedAt", async () => {
    const user = await makeOAuthShapedUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const missing = await postConsent(req({}));
    expect(missing.status).toBe(400);
    const explicitFalse = await postConsent(req({ tosAccepted: false }));
    expect(explicitFalse.status).toBe(400);

    const stillPending = await prisma.cpUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillPending.tosAcceptedAt).toBeNull();
  });

  it("with tosAccepted true, sets tosAcceptedAt and leaves marketingConsent false by default", async () => {
    const user = await makeOAuthShapedUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const res = await postConsent(req({ tosAccepted: true }));
    expect(res.status).toBe(200);

    const updated = await prisma.cpUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.tosAcceptedAt).not.toBeNull();
    expect((await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } })).consent).toBe(false);
  });

  it("with tosAccepted true and marketingConsent true, grants marketing consent with the oauth source", async () => {
    const user = await makeOAuthShapedUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const res = await postConsent(req({ tosAccepted: true, marketingConsent: true }));
    expect(res.status).toBe(200);

    const updated = await prisma.marketingConsent.findUniqueOrThrow({ where: { userId: user.id } });
    expect(updated.consent).toBe(true);
    expect(updated.consentSource).toBe("oauth_welcome_interstitial");
  });
});
