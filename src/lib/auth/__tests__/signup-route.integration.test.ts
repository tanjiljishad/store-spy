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
});
