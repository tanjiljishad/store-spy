import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyCredentials } from "../verify-credentials";
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
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account","User" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

describe("verifyCredentials", () => {
  it("succeeds with the right email/password", async () => {
    const email = `${randomUUID()}@example.com`;
    await makeStoreSpyUser(prisma, { email, passwordHash: await hashPassword("correct-password") });

    const identity = await verifyCredentials(prisma, email, "correct-password");
    expect(identity?.email).toBe(email);
  });

  it("is case/whitespace-insensitive on email, matching normalizeEmail", async () => {
    const email = `${randomUUID()}@example.com`;
    await makeStoreSpyUser(prisma, { email, passwordHash: await hashPassword("correct-password") });

    const identity = await verifyCredentials(prisma, ` ${email.toUpperCase()} `, "correct-password");
    expect(identity?.email).toBe(email);
  });

  it("returns null for the wrong password", async () => {
    const email = `${randomUUID()}@example.com`;
    await makeStoreSpyUser(prisma, { email, passwordHash: await hashPassword("correct-password") });

    expect(await verifyCredentials(prisma, email, "wrong-password")).toBeNull();
  });

  it("returns null for an email that doesn't exist", async () => {
    expect(await verifyCredentials(prisma, "nobody@example.com", "anything")).toBeNull();
  });

  it("returns null for an OAuth-only user (no passwordHash) — never crashes on a null hash", async () => {
    const email = `${randomUUID()}@example.com`;
    await makeStoreSpyUser(prisma, { email }); // no passwordHash — as if created via Google sign-in

    expect(await verifyCredentials(prisma, email, "anything")).toBeNull();
  });
});
