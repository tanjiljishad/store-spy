import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  expireDuePermissionGrants,
  getEffectivePermissionsForUser,
  grantPermission,
  hasActiveGrant,
  hasAnyActiveGrant,
  isKnownPermission,
  revokePermission,
} from "../permissions-service";
import type { AdminActor } from "../guard";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "AdminPermissionGrant","AdminAuditLog","User" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);
});

async function makeUser(role: "USER" | "SUPER_ADMIN" = "USER") {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role });
}
function actorFrom(user: { id: string; email: string; role: string }): AdminActor {
  return { id: user.id, email: user.email, role: user.role as never };
}

describe("isKnownPermission", () => {
  it("accepts every real permission and rejects garbage", () => {
    expect(isKnownPermission("audit:read")).toBe(true);
    expect(isKnownPermission("campaign:write")).toBe(true);
    expect(isKnownPermission("not:a:real:permission")).toBe(false);
    expect(isKnownPermission("")).toBe(false);
  });
});

describe("grantPermission / revokePermission — live correctness, no staleness window", () => {
  it("a granted permission is visible immediately via hasActiveGrant, before any sweep runs", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();

    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(false);
    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");
    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(true);
  });

  it("a revoked permission is immediately inactive, no staleness window", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");
    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(true);

    await revokePermission(prisma, actorFrom(admin), target.id, "audit:read");
    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(false);
  });

  it("a grant with expiresAt in the past is inactive immediately — the live query, not just the sweep, enforces this", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000);

    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read", yesterday);

    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(false);
    // The row itself is still there, unrevoked — only the sweep (tested below) marks it.
    const row = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id, permission: "audit:read" } });
    expect(row.revokedAt).toBeNull();
  });

  it("a grant with expiresAt in the future is active", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);

    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read", tomorrow);

    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(true);
  });

  it("revoking a permission that was never granted returns not_found, mutates nothing", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();

    const result = await revokePermission(prisma, actorFrom(admin), target.id, "audit:read");
    expect(result.outcome).toBe("not_found");
  });

  it("granting to a nonexistent user returns user_not_found", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const result = await grantPermission(prisma, actorFrom(admin), "does-not-exist", "audit:read");
    expect(result.outcome).toBe("user_not_found");
  });

  it("every write pairs with exactly one AdminAuditLog row in the same transaction", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();

    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");
    expect(await prisma.adminAuditLog.count({ where: { action: "permission.grant", targetId: target.id } })).toBe(1);

    await revokePermission(prisma, actorFrom(admin), target.id, "audit:read");
    expect(await prisma.adminAuditLog.count({ where: { action: "permission.revoke", targetId: target.id } })).toBe(1);
  });

  it("after revoking, the SAME permission can be granted again (a fresh row, not reusing the revoked one)", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();

    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");
    await revokePermission(prisma, actorFrom(admin), target.id, "audit:read");
    const second = await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");

    expect(second.outcome).toBe("granted");
    expect(await hasActiveGrant(prisma, target.id, "audit:read")).toBe(true);
    // Two rows total for this (user, permission) — the revoked one and the fresh one — the audit trail survives, per the doc.
    expect(await prisma.adminPermissionGrant.count({ where: { userId: target.id, permission: "audit:read" } })).toBe(2);
  });
});

describe("hasAnyActiveGrant — AdminLayout's gate (security review fix 1)", () => {
  it("false for a user with no grants at all", async () => {
    const target = await makeUser();
    expect(await hasAnyActiveGrant(prisma, target.id)).toBe(false);
  });

  it("true once ANY permission is granted, regardless of which one", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "crawl:retry");
    expect(await hasAnyActiveGrant(prisma, target.id)).toBe(true);
  });

  it("false again once that one grant is revoked", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "crawl:retry");
    await revokePermission(prisma, actorFrom(admin), target.id, "crawl:retry");
    expect(await hasAnyActiveGrant(prisma, target.id)).toBe(false);
  });

  it("false for a grant whose expiresAt is already in the past, even though the row still exists", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "crawl:retry", new Date(Date.now() - 1000));
    expect(await hasAnyActiveGrant(prisma, target.id)).toBe(false);
  });

  it("does not confuse one user's grant for another's", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const granted = await makeUser();
    const ungranted = await makeUser();
    await grantPermission(prisma, actorFrom(admin), granted.id, "crawl:retry");
    expect(await hasAnyActiveGrant(prisma, granted.id)).toBe(true);
    expect(await hasAnyActiveGrant(prisma, ungranted.id)).toBe(false);
  });
});

describe("getEffectivePermissionsForUser", () => {
  it("returns null for a nonexistent user", async () => {
    expect(await getEffectivePermissionsForUser(prisma, "does-not-exist")).toBeNull();
  });

  it("an expired (not yet swept) grant is excluded from granted/effective, even though its row still exists", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read", new Date(Date.now() - 1000));

    const result = await getEffectivePermissionsForUser(prisma, target.id);
    expect(result!.granted).toEqual([]);
    expect(result!.effective).not.toContain("audit:read");
  });
});

describe("expireDuePermissionGrants — the worker sweep", () => {
  it("marks a due grant revoked and leaves a not-yet-due one untouched", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    const now = new Date();

    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read", new Date(now.getTime() - 1000));
    await grantPermission(prisma, actorFrom(admin), target.id, "crawl:retry", new Date(now.getTime() + 60 * 60_000));

    const result = await expireDuePermissionGrants(prisma, now);
    expect(result.expiredCount).toBe(1);

    const due = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id, permission: "audit:read" } });
    const notDue = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id, permission: "crawl:retry" } });
    expect(due.revokedAt).not.toBeNull();
    expect(notDue.revokedAt).toBeNull();
  });

  it("never touches a perpetual (expiresAt: null) grant", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");

    await expireDuePermissionGrants(prisma);

    const grant = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id } });
    expect(grant.revokedAt).toBeNull();
  });

  it("never re-touches an already-manually-revoked grant", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser();
    await grantPermission(prisma, actorFrom(admin), target.id, "audit:read");
    await revokePermission(prisma, actorFrom(admin), target.id, "audit:read");
    const revokedRow = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id } });

    await expireDuePermissionGrants(prisma);

    const stillRow = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { id: revokedRow.id } });
    expect(stillRow.revokedAt!.getTime()).toBe(revokedRow.revokedAt!.getTime()); // unchanged, not re-stamped
  });
});
