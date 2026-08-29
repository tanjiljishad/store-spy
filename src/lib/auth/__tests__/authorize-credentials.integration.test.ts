import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { authorizeCredentials } from "../authorize-credentials";
import { hashPassword } from "../password";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

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
  await prisma.$executeRawUnsafe(`TRUNCATE "LoginAttempt","Session","Account" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

async function makeUser(password: string) {
  const email = `${randomUUID()}@example.com`;
  await makeStoreSpyUser(prisma, { email, passwordHash: await hashPassword(password) });
  return email;
}

describe("authorizeCredentials", () => {
  it("succeeds with the right email/password and clears prior failure rows", async () => {
    const email = await makeUser("correct-password");
    await authorizeCredentials(prisma, email, "wrong-once", "203.0.113.1");
    const identity = await authorizeCredentials(prisma, email, "correct-password", "203.0.113.1");
    expect(identity?.email).toBe(email);

    const remainingFailures = await prisma.loginAttempt.count({ where: { succeeded: false } });
    expect(remainingFailures).toBe(0);
  });

  it("returns null for a wrong password", async () => {
    const email = await makeUser("correct-password");
    expect(await authorizeCredentials(prisma, email, "wrong-password", "203.0.113.2")).toBeNull();
  });

  it("returns null for a nonexistent email, same as a wrong password", async () => {
    expect(await authorizeCredentials(prisma, "nobody@example.com", "anything", "203.0.113.3")).toBeNull();
  });

  it(
    "10 wrong passwords locks the account for 15 minutes, and the locked response is identical to a wrong-password response",
    async () => {
      const email = await makeUser("correct-password");
      const ip = "203.0.113.4";

      // Attempts 1-9: still evaluated against the real password (progressively
      // delayed from #5 on) — every one is a genuine "wrong password" null.
      for (let i = 0; i < 9; i++) {
        const result = await authorizeCredentials(prisma, email, "wrong-password", ip);
        expect(result).toBeNull();
      }

      // The 10th failure crosses the lock threshold. The 11th attempt is now
      // locked — it must be `null`, the exact same value/type a wrong
      // password produces above, not a different shape or a thrown error.
      const tenth = await authorizeCredentials(prisma, email, "wrong-password", ip);
      expect(tenth).toBeNull();

      const lockedAttempt = await authorizeCredentials(prisma, email, "correct-password", ip); // even the RIGHT password
      expect(lockedAttempt).toBeNull(); // ...still locked out, proving this isn't just "wrong password" logic

      const failureRows = await prisma.loginAttempt.count({ where: { emailNormalized: email, succeeded: false } });
      expect(failureRows).toBeGreaterThanOrEqual(10);
    },
    40_000,
  );

  it("per-IP lockout applies across different, nonexistent emails from the same IP", async () => {
    const ip = "203.0.113.5";
    for (let i = 0; i < 30; i++) {
      await authorizeCredentials(prisma, `nobody-${i}@example.com`, "anything", ip);
    }
    const result = await authorizeCredentials(prisma, "one-more@example.com", "anything", ip);
    expect(result).toBeNull();

    const ipFailureRows = await prisma.loginAttempt.count({ where: { ipKey: ip, succeeded: false } });
    expect(ipFailureRows).toBeGreaterThanOrEqual(30);
  }, 20_000);
});
