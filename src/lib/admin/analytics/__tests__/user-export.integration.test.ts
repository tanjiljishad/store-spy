import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { exportUsers, exportUsersWithAudit } from "../user-export";
import type { AdminActor } from "../../guard";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "AdminAuditLog","Session","Account" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

async function makeActor(): Promise<AdminActor> {
  const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role: "SUPER_ADMIN" });
  return { id: user.id, email: user.email, role: "SUPER_ADMIN" } as AdminActor;
}

describe("exportUsers", () => {
  it("respects plan/role/email filters, same as searchUsers", async () => {
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "BUSINESS" });
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });

    const rows = await exportUsers(prisma, { plan: "BUSINESS" });
    expect(rows).toHaveLength(1);
    expect(rows[0].plan).toBe("BUSINESS");
  });

  it("never includes passwordHash or any other field outside the declared allowlist", async () => {
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, passwordHash: "bcrypt$fake$hash" });
    const rows = await exportUsers(prisma);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "email", "id", "plan", "role"].sort());
  });
});

describe("exportUsersWithAudit", () => {
  it("purpose:\"support\" exports rows and writes one audit row recording row count, filters, and purpose", async () => {
    const actor = await makeActor();
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "BASIC" });
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });

    const result = await exportUsersWithAudit(prisma, actor, { plan: "BASIC" }, "support");
    expect(result.outcome).toBe("exported");
    if (result.outcome !== "exported") throw new Error("unreachable");
    expect(result.rows).toHaveLength(1);

    const auditRows = await prisma.adminAuditLog.findMany({ where: { action: "user.export" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actorId).toBe(actor.id);
    expect(auditRows[0].metadata).toMatchObject({ rowCount: 1, purpose: "support", filters: { plan: "BASIC" } });
  });

  // Milestone 12 §4.1: "purpose:'marketing' returns only consented users."
  it("purpose:\"marketing\" returns ONLY marketingConsent=true users — an unconsented user never appears", async () => {
    const actor = await makeActor();
    const consented = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, marketingConsent: true });
    const unconsented = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, marketingConsent: false });

    const result = await exportUsersWithAudit(prisma, actor, {}, "marketing");
    expect(result.outcome).toBe("exported");
    if (result.outcome !== "exported") throw new Error("unreachable");
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(consented.id);
    expect(ids).not.toContain(unconsented.id);

    const auditRows = await prisma.adminAuditLog.findMany({ where: { action: "user.export" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toMatchObject({ purpose: "marketing" });
  });

  it("purpose:\"marketing\" combined with a plan filter still excludes unconsented users of that plan", async () => {
    const actor = await makeActor();
    await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "BUSINESS", marketingConsent: true });
    const unconsentedBusiness = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "BUSINESS", marketingConsent: false });

    const result = await exportUsersWithAudit(prisma, actor, { plan: "BUSINESS" }, "marketing");
    if (result.outcome !== "exported") throw new Error("unreachable");
    expect(result.rows).toHaveLength(1);
    expect(result.rows.map((r) => r.id)).not.toContain(unconsentedBusiness.id);
  });

  it("purpose:\"support\" is unaffected by consent status — includes both consented and unconsented users", async () => {
    const actor = await makeActor();
    const consented = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, marketingConsent: true });
    const unconsented = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, marketingConsent: false });

    const result = await exportUsersWithAudit(prisma, actor, {}, "support");
    if (result.outcome !== "exported") throw new Error("unreachable");
    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain(consented.id);
    expect(ids).toContain(unconsented.id); // "support" ignores consent entirely, unlike "marketing"
  });
});
