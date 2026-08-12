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
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account","User" RESTART IDENTITY CASCADE`);
  _resetRateLimitState();
});

function req(body: unknown, ip = "203.0.113.9"): NextRequest {
  return new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
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
});
