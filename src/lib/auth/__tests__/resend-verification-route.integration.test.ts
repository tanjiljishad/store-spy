import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {
    constructor() {
      super("Unauthorized");
      this.name = "UnauthorizedError";
    }
  }
  const getCurrentUser = vi.fn();
  const requireUser = async () => {
    const user = await getCurrentUser();
    if (!user) throw new UnauthorizedError();
    return user;
  };
  return { getCurrentUser, requireUser, UnauthorizedError };
});

vi.mock("@/lib/email/verification-email", () => ({ sendVerificationEmail: vi.fn() }));

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { POST as resendVerification } from "../../../app/api/auth/resend-verification/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { sendVerificationEmail } from "@/lib/email/verification-email";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account","User" RESTART IDENTITY CASCADE`);
  _resetRateLimitState();
  vi.mocked(getCurrentUser).mockReset();
  vi.mocked(sendVerificationEmail).mockReset();
  vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);
});

function req(): NextRequest {
  return new NextRequest("http://localhost/api/auth/resend-verification", { method: "POST" });
}
async function makeUnverifiedUser() {
  return prisma.user.create({ data: { email: `${randomUUID()}@example.com` } });
}

describe("POST /api/auth/resend-verification", () => {
  it("401s an anonymous caller", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await resendVerification(req());
    expect(res.status).toBe(401);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("sends and returns 200 for a signed-in, unverified account", async () => {
    const user = await makeUnverifiedUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const res = await resendVerification(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "sent" });
    expect(sendVerificationEmail).toHaveBeenCalledWith(expect.any(String), user.id, user.email);
  });

  it("does not send, and reports already_verified, for an already-verified account", async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, emailVerified: new Date() } });
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    const res = await resendVerification(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "already_verified" });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("returns 502 when the send itself fails, without crashing", async () => {
    const user = await makeUnverifiedUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });
    vi.mocked(sendVerificationEmail).mockRejectedValue(new Error("Resend API error"));

    const res = await resendVerification(req());
    expect(res.status).toBe(502);
  });

  it("rate limits repeated requests from the same account", async () => {
    const user = await makeUnverifiedUser();
    vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: "USER" });

    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await resendVerification(req());
    }
    expect(last!.status).toBe(429);
  });
});
