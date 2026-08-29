import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 2 acceptance criterion: every mutating admin route writes exactly
 * one audit row, and a forced failure of the audit write rolls the change
 * back. recordAdminAction() is mocked to throw on demand — everything else
 * (users-service.ts, real Postgres) stays real, so this proves the actual
 * transaction boundary, not a simulated one.
 */
vi.mock("../audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit")>();
  return { ...actual, recordAdminAction: vi.fn(actual.recordAdminAction) };
});

import { PrismaClient } from "@prisma/client";
import { recordAdminAction } from "../audit";
import { revokeUserSessions, updateUserPlanWithAudit, updateUserRole } from "../users-service";
import type { AdminActor } from "../guard";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "AdminAuditLog","Session","Account","User" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

afterEach(() => {
  // mockRejectedValueOnce is self-expiring — after being consumed once, the
  // spy reverts to its default behavior (set in the vi.mock factory above:
  // delegate to the real recordAdminAction). Only call history needs clearing.
  vi.mocked(recordAdminAction).mockClear();
});

async function makeActor(): Promise<AdminActor> {
  const u = await makeStoreSpyUser(prisma, { role: "SUPER_ADMIN" });
  return { id: u.id, email: u.email, role: "SUPER_ADMIN" };
}

describe("admin writes pair with exactly one audit row, atomically", () => {
  it("updateUserRole: succeeds normally and writes exactly one audit row", async () => {
    const actor = await makeActor();
    const target = await makeStoreSpyUser(prisma, { role: "USER" });

    const result = await updateUserRole(prisma, actor, target.id, "SUPPORT_ADMIN");

    expect(result.outcome).toBe("updated");
    const rows = await prisma.adminAuditLog.count({ where: { targetId: target.id, action: "user.role.update" } });
    expect(rows).toBe(1);
  });

  it("updateUserRole: a forced audit-write failure rolls back the role change", async () => {
    const actor = await makeActor();
    const target = await makeStoreSpyUser(prisma, { role: "USER" });

    vi.mocked(recordAdminAction).mockRejectedValueOnce(new Error("simulated audit write failure"));

    await expect(updateUserRole(prisma, actor, target.id, "SUPPORT_ADMIN")).rejects.toThrow("simulated audit write failure");

    const stillTarget = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillTarget.role).toBe("USER"); // rolled back — never persisted despite the update running first
    const rows = await prisma.adminAuditLog.count({ where: { targetId: target.id } });
    expect(rows).toBe(0);
  });

  it("updateUserPlanWithAudit: succeeds normally and writes exactly one audit row", async () => {
    const actor = await makeActor();
    const target = await makeStoreSpyUser(prisma, { plan: "FREE" });

    const result = await updateUserPlanWithAudit(prisma, actor, target.id, "BASIC");

    expect(result.outcome).toBe("updated");
    const rows = await prisma.adminAuditLog.count({ where: { targetId: target.id, action: "user.plan.update" } });
    expect(rows).toBe(1);
  });

  it("updateUserPlanWithAudit: a forced audit-write failure rolls back the plan change", async () => {
    const actor = await makeActor();
    const target = await makeStoreSpyUser(prisma, { plan: "FREE" });

    vi.mocked(recordAdminAction).mockRejectedValueOnce(new Error("simulated audit write failure"));

    await expect(updateUserPlanWithAudit(prisma, actor, target.id, "BASIC")).rejects.toThrow("simulated audit write failure");

    const stillTarget = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillTarget.plan).toBe("FREE");
    const rows = await prisma.adminAuditLog.count({ where: { targetId: target.id } });
    expect(rows).toBe(0);
  });

  it("revokeUserSessions: succeeds normally and writes exactly one audit row", async () => {
    const actor = await makeActor();
    const target = await makeStoreSpyUser(prisma);

    const result = await revokeUserSessions(prisma, actor, target.id);

    expect(result.outcome).toBe("revoked");
    const rows = await prisma.adminAuditLog.count({ where: { targetId: target.id, action: "user.sessions.revoke" } });
    expect(rows).toBe(1);
  });

  it("revokeUserSessions: a forced audit-write failure rolls back sessionsValidAfter", async () => {
    const actor = await makeActor();
    const target = await makeStoreSpyUser(prisma);

    vi.mocked(recordAdminAction).mockRejectedValueOnce(new Error("simulated audit write failure"));

    await expect(revokeUserSessions(prisma, actor, target.id)).rejects.toThrow("simulated audit write failure");

    const stillTarget = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(stillTarget.sessionsValidAfter).toBeNull();
    const rows = await prisma.adminAuditLog.count({ where: { targetId: target.id } });
    expect(rows).toBe(0);
  });
});
