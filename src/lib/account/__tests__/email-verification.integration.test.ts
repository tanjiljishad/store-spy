import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { needsEmailVerification } from "../email-verification";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await resetControlPlane(prisma);
});

describe("needsEmailVerification", () => {
  it("is true for a freshly credentials-created account (emailVerified never set)", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, passwordHash: "irrelevant" });
    expect(await needsEmailVerification(prisma, user.id)).toBe(true);
  });

  it("is false once emailVerified is set (clicked the mailed link, or an OAuth-created row)", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, emailVerified: new Date() });
    expect(await needsEmailVerification(prisma, user.id)).toBe(false);
  });

  it("is false for a nonexistent user — nothing left to gate", async () => {
    expect(await needsEmailVerification(prisma, "does-not-exist")).toBe(false);
  });
});
