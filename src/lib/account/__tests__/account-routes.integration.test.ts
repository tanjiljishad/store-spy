import { describe, expect, it, beforeEach, vi } from "vitest";

// Session is mocked at the getCurrentUser seam (the real module pulls in
// next-auth, which doesn't resolve under vitest ESM). requireUser /
// requireVerifiedUser are re-implemented here to MATCH the real ones —
// requireVerifiedUser (audit fix M-3) runs the same needsEmailVerification()
// check against the real test DB, so the gate is genuinely exercised.
const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));
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
  class EmailNotVerifiedError extends Error {
    constructor() {
      super("Email not verified");
      this.name = "EmailNotVerifiedError";
    }
  }
  const requireUser = async () => {
    const user = await mockGetCurrentUser();
    if (!user) throw new UnauthorizedError();
    return user;
  };
  const requireVerifiedUser = async () => {
    const user = await requireUser();
    const { prisma } = await import("@/lib/db/prisma");
    const { needsEmailVerification } = await import("@/lib/account/email-verification");
    if (await needsEmailVerification(prisma, user.id)) throw new EmailNotVerifiedError();
    return user;
  };
  return { getCurrentUser: mockGetCurrentUser, requireUser, requireVerifiedUser, UnauthorizedError, ForbiddenError, EmailNotVerifiedError };
});

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET as exportAccount } from "../../../app/api/account/export/route";
import { POST as deleteAccount } from "../../../app/api/account/delete/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","Checkout","Subscription","AnalysisUsage","Watchlist","Session","Account","Store" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  mockGetCurrentUser.mockReset();
  await resetControlPlane(prisma);
});

function deleteReq(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/delete", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function makeUser(
  overrides: Partial<{ email: string; plan: "FREE" | "BASIC" | "BUSINESS"; role: "USER" | "SUPER_ADMIN"; verified: boolean }> = {},
) {
  return makeStoreSpyUser(prisma, {
    email: overrides.email ?? `${randomUUID()}@example.com`,
    plan: overrides.plan ?? "FREE",
    role: overrides.role ?? "USER",
    // Audit fix M-3: export/delete now require a verified email — default here.
    emailVerified: (overrides.verified ?? true) ? new Date() : null,
  });
}

describe("GET /api/account/export", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await exportAccount();
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's own data as a downloadable JSON attachment", async () => {
    const user = await makeUser({ plan: "BASIC" });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const res = await exportAccount();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.json();
    expect(body.profile.id).toBe(user.id);
    expect(body.profile.email).toBe(user.email);
  });

  // Audit fix M-3: an unverified signed-in account cannot pull its export.
  it("403s a signed-in but unverified account", async () => {
    const user = await makeUser({ verified: false });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const res = await exportAccount();
    expect(res.status).toBe(403);
  });
});

describe("POST /api/account/delete", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await deleteAccount(deleteReq({ confirmEmail: "whatever@example.com" }));
    expect(res.status).toBe(401);
  });

  it("400s when confirmEmail is missing or doesn't match the caller's own email", async () => {
    const user = await makeUser();
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const missing = await deleteAccount(deleteReq({}));
    expect(missing.status).toBe(400);
    const wrong = await deleteAccount(deleteReq({ confirmEmail: "someone-else@example.com" }));
    expect(wrong.status).toBe(400);

    expect(await prisma.cpUser.findUnique({ where: { id: user.id } })).not.toBeNull(); // never deleted
  });

  it("deletes the account when confirmEmail matches (case/whitespace-insensitive)", async () => {
    const user = await makeUser({ email: "Real.User@Example.com" });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const res = await deleteAccount(deleteReq({ confirmEmail: "  real.USER@example.COM  " }));
    expect(res.status).toBe(200);
    expect(await prisma.cpUser.findUnique({ where: { id: user.id } })).toBeNull();
  });

  // Audit fix M-3: an unverified account cannot delete itself via the API
  // (the confirm-email step is never even reached).
  it("403s a signed-in but unverified account, before the confirm-email check", async () => {
    const user = await makeUser({ verified: false });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const res = await deleteAccount(deleteReq({ confirmEmail: user.email }));
    expect(res.status).toBe(403);
    expect(await prisma.cpUser.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it("409s a lone SUPER_ADMIN attempting to delete themselves, via the real HTTP route", async () => {
    const admin = await makeUser({ role: "SUPER_ADMIN" });
    mockGetCurrentUser.mockResolvedValue({ id: admin.id, email: admin.email, role: "SUPER_ADMIN" });

    const res = await deleteAccount(deleteReq({ confirmEmail: admin.email }));
    expect(res.status).toBe(409);
    expect(await prisma.cpUser.findUnique({ where: { id: admin.id } })).not.toBeNull();
  });
});
