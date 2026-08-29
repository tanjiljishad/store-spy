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
import { GET as exportAccount } from "../../../app/api/account/export/route";
import { POST as deleteAccount } from "../../../app/api/account/delete/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","Checkout","Subscription","AnalysisUsage","Watchlist","Session","Account","Store" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  vi.mocked(getCurrentUser).mockReset();
  await resetControlPlane(prisma);
});

function deleteReq(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/account/delete", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function makeUser(overrides: Partial<{ email: string; plan: "FREE" | "BASIC" | "BUSINESS"; role: "USER" | "SUPER_ADMIN" }> = {}) {
  return makeStoreSpyUser(prisma, {
    email: overrides.email ?? `${randomUUID()}@example.com`,
    plan: overrides.plan ?? "FREE",
    role: overrides.role ?? "USER",
  });
}

describe("GET /api/account/export", () => {
  it("401s an anonymous caller", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await exportAccount();
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's own data as a downloadable JSON attachment", async () => {
    const user = await makeUser({ plan: "BASIC" });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const res = await exportAccount();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.json();
    expect(body.profile.id).toBe(user.id);
    expect(body.profile.email).toBe(user.email);
  });
});

describe("POST /api/account/delete", () => {
  it("401s an anonymous caller", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await deleteAccount(deleteReq({ confirmEmail: "whatever@example.com" }));
    expect(res.status).toBe(401);
  });

  it("400s when confirmEmail is missing or doesn't match the caller's own email", async () => {
    const user = await makeUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const missing = await deleteAccount(deleteReq({}));
    expect(missing.status).toBe(400);
    const wrong = await deleteAccount(deleteReq({ confirmEmail: "someone-else@example.com" }));
    expect(wrong.status).toBe(400);

    expect(await prisma.cpUser.findUnique({ where: { id: user.id } })).not.toBeNull(); // never deleted
  });

  it("deletes the account when confirmEmail matches (case/whitespace-insensitive)", async () => {
    const user = await makeUser({ email: "Real.User@Example.com" });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });

    const res = await deleteAccount(deleteReq({ confirmEmail: "  real.USER@example.COM  " }));
    expect(res.status).toBe(200);
    expect(await prisma.cpUser.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it("409s a lone SUPER_ADMIN attempting to delete themselves, via the real HTTP route", async () => {
    const admin = await makeUser({ role: "SUPER_ADMIN" });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: admin.id, email: admin.email, role: "SUPER_ADMIN" });

    const res = await deleteAccount(deleteReq({ confirmEmail: admin.email }));
    expect(res.status).toBe(409);
    expect(await prisma.cpUser.findUnique({ where: { id: admin.id } })).not.toBeNull();
  });
});
