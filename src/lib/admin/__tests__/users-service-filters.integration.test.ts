import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { searchUsers } from "../users-service";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/** Milestone 12 §3.3: "GET /api/admin/users gains search, plan/role filters, and sort." */
const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

describe("searchUsers plan/role filters and sort", () => {
  it("filters by plan", async () => {
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "BUSINESS" });

    const page = await searchUsers(prisma, { plan: "BUSINESS" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].plan).toBe("BUSINESS");
  });

  it("filters by role", async () => {
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "USER" });
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "MANAGER" });

    const page = await searchUsers(prisma, { role: "MANAGER" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].role).toBe("MANAGER");
  });

  it("combines email, plan, and role filters (AND, not OR)", async () => {
    const target = await makeStoreSpyUser(prisma, { email: "target-user@example.com", plan: "BASIC", role: "SUPPORT_ADMIN" });
    await makeStoreSpyUser(prisma, { email: "target-other-plan@example.com", plan: "FREE", role: "SUPPORT_ADMIN" });

    const page = await searchUsers(prisma, { emailQuery: "target", plan: "BASIC", role: "SUPPORT_ADMIN" });
    expect(page.items.map((u) => u.id)).toEqual([target.id]);
  });

  it("defaults to createdAt descending, and sort=createdAt_asc reverses it", async () => {
    const older = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: older.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    const newer = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: newer.id }, data: { createdAt: new Date("2026-06-01T00:00:00Z") } });

    const desc = await searchUsers(prisma);
    expect(desc.items.map((u) => u.id)).toEqual([newer.id, older.id]);

    const asc = await searchUsers(prisma, { sort: "createdAt_asc" });
    expect(asc.items.map((u) => u.id)).toEqual([older.id, newer.id]);
  });
});
