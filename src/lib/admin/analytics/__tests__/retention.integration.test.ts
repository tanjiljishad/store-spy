import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getCohortRetention } from "../retention";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "Subscription","Session","Account","User" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

const RANGE_START = new Date("2026-06-01T00:00:00Z");
const RANGE_END = new Date("2026-09-01T00:00:00Z");

async function makeUser(createdAt: Date, plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") {
  const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan });
  await prisma.user.update({ where: { id: user.id }, data: { createdAt } });
  return user;
}

describe("getCohortRetention", () => {
  it("groups users into their UTC signup month, one row per cohort", async () => {
    await makeUser(new Date("2026-07-03T00:00:00Z"));
    await makeUser(new Date("2026-07-29T23:59:00Z"));
    await makeUser(new Date("2026-08-01T00:00:01Z"));

    const cohorts = await getCohortRetention(prisma, RANGE_START, RANGE_END);
    const july = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-07-01T00:00:00.000Z");
    const august = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-08-01T00:00:00.000Z");
    expect(july?.cohortSize).toBe(2);
    expect(august?.cohortSize).toBe(1);
  });

  it("everPaid is true for a user with any Subscription row, even if they've since churned back to FREE", async () => {
    const churnedBack = await makeUser(new Date("2026-07-05T00:00:00Z"), "FREE");
    await prisma.subscription.create({ data: { userId: churnedBack.id, plan: "BASIC", source: "PROVIDER", status: "EXPIRED", startedAt: new Date("2026-07-06T00:00:00Z"), expiresAt: new Date("2026-07-20T00:00:00Z") } });
    await makeUser(new Date("2026-07-10T00:00:00Z"), "FREE"); // never paid

    const cohorts = await getCohortRetention(prisma, RANGE_START, RANGE_END);
    const july = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-07-01T00:00:00.000Z")!;
    expect(july.cohortSize).toBe(2);
    expect(july.everPaid).toBe(1);
    expect(july.currentlyPaid).toBe(0); // churned back to FREE — everPaid and currentlyPaid diverge
    expect(july.everPaidRate).toBeCloseTo(0.5, 5);
  });

  it("currentlyPaid reflects the user's CURRENT plan, independent of Subscription history", async () => {
    await makeUser(new Date("2026-07-05T00:00:00Z"), "BUSINESS"); // plan set directly (e.g. admin grant), no Subscription row at all

    const cohorts = await getCohortRetention(prisma, RANGE_START, RANGE_END);
    const july = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-07-01T00:00:00.000Z")!;
    expect(july.currentlyPaid).toBe(1);
    expect(july.everPaid).toBe(0); // no Subscription row — currentlyPaid and everPaid are genuinely independent signals
  });
});
