import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Milestone 12 §2.4's privilege-escalation invariants, written FIRST per
 * the doc's own instruction and Milestone 11 Phase 2's precedent — these
 * fail (the routes don't exist yet) until Phase 2 is actually built. Full
 * synthetic mock of @/lib/auth/session, same reason as
 * role-route-invariants.integration.test.ts: loading the real next-auth
 * chain inside vitest's SSR module loader hits an unrelated ESM-resolution
 * issue in next-auth's own "next/server" import. admin/guard.ts (which
 * these routes go through) needs requireUser() and both error classes from
 * this same module, not just getCurrentUser() — reimplemented here verbatim
 * rather than importOriginal()'d, which would pull the real chain back in.
 */
vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {
    constructor() {
      super("Unauthorized");
      this.name = "UnauthorizedError";
    }
  }
  class ForbiddenError extends Error {
    constructor(message = "Forbidden") {
      super(message);
      this.name = "ForbiddenError";
    }
  }
  const getCurrentUser = vi.fn();
  const requireUser = async () => {
    const user = await getCurrentUser();
    if (!user) throw new UnauthorizedError();
    return user;
  };
  return { getCurrentUser, requireUser, UnauthorizedError, ForbiddenError };
});

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET as getPermissions, POST as postPermission } from "../../../app/api/admin/users/[id]/permissions/route";
import { DELETE as deletePermission } from "../../../app/api/admin/users/[id]/permissions/[permission]/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();

afterEach(() => {
  vi.mocked(getCurrentUser).mockReset();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "AdminPermissionGrant","AdminAuditLog","Session","Account","User" RESTART IDENTITY CASCADE`);
  _resetRateLimitState();
  await resetControlPlane(prisma);
});

async function makeUser(role: "USER" | "SUPPORT_ADMIN" | "BILLING_ADMIN" | "CONTENT_ADMIN" | "MANAGER" | "SUPER_ADMIN" = "USER") {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role });
}

function req(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users/x/permissions", {
    method: body !== undefined ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function deleteReq(): NextRequest {
  return new NextRequest("http://localhost/api/admin/users/x/permissions/y", {
    method: "DELETE",
    headers: { "x-forwarded-for": "203.0.113.11" },
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function ctxWithPermission(id: string, permission: string) {
  return { params: Promise.resolve({ id, permission }) };
}

/** Fires postPermission as `actor` targeting `targetId` — signs in fresh right before the call, since mocks are shared, not per-request. */
async function grantAs(actor: { id: string; email: string; role: string }, targetId: string, body: unknown) {
  vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: actor.id, email: actor.email, plan: "FREE", role: actor.role as never });
  return postPermission(req(body), ctx(targetId));
}
async function revokeAs(actor: { id: string; email: string; role: string }, targetId: string, permission: string) {
  vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: actor.id, email: actor.email, plan: "FREE", role: actor.role as never });
  return deletePermission(deleteReq(), ctxWithPermission(targetId, permission));
}

describe("POST /api/admin/users/[id]/permissions — privilege-escalation invariants", () => {
  it("1. an actor cannot grant a permission to themselves, even SUPER_ADMIN", async () => {
    const admin = await makeUser("SUPER_ADMIN");

    const res = await grantAs(admin, admin.id, { permission: "audit:read" });

    expect(res.status).toBe(403);
    const grants = await prisma.adminPermissionGrant.count({ where: { userId: admin.id } });
    expect(grants).toBe(0);
  });

  it("2. an actor lacking permission:grant cannot grant anything at all (generic permission gate)", async () => {
    const actor = await makeUser("MANAGER"); // no permission:grant in the matrix
    const target = await makeUser("USER");

    const res = await grantAs(actor, target.id, { permission: "audit:read" });

    expect(res.status).toBe(403);
    const grants = await prisma.adminPermissionGrant.count({ where: { userId: target.id } });
    expect(grants).toBe(0);
  });

  it("3. every SUPER_ADMIN_ONLY permission is rejected by the route, even when the actor IS a SUPER_ADMIN", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const res = await grantAs(admin, target.id, { permission: "billing:refund" });

    expect(res.status).toBe(403);
    const grants = await prisma.adminPermissionGrant.count({ where: { userId: target.id } });
    expect(grants).toBe(0);
  });

  it("4. permission:grant itself can never be granted through this route, even by a SUPER_ADMIN", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const res = await grantAs(admin, target.id, { permission: "permission:grant" });

    expect(res.status).toBe(403);
    const grants = await prisma.adminPermissionGrant.count({ where: { userId: target.id } });
    expect(grants).toBe(0);
  });

  it("5. an unknown/garbage permission string is rejected with 400, not silently accepted", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const res = await grantAs(admin, target.id, { permission: "not:a:real:permission" });

    expect(res.status).toBe(400);
  });

  it("6. granting a real, non-protected permission succeeds and is visible immediately (no JWT caching to wait out)", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const res = await grantAs(admin, target.id, { permission: "audit:read" });
    expect(res.status).toBe(200);

    const grant = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id, permission: "audit:read" } });
    expect(grant.revokedAt).toBeNull();
    expect(grant.grantedByUserId).toBe(admin.id);
  });

  it("7. two concurrent grants of the SAME permission to the SAME user produce exactly one active grant row", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const [a, b] = await Promise.all([
      grantAs(admin, target.id, { permission: "audit:read" }),
      grantAs(admin, target.id, { permission: "audit:read" }),
    ]);

    expect([a.status, b.status].every((s) => s === 200)).toBe(true); // idempotent — neither call should hard-fail
    const activeGrants = await prisma.adminPermissionGrant.count({ where: { userId: target.id, permission: "audit:read", revokedAt: null } });
    expect(activeGrants).toBe(1);
  });
});

describe("DELETE /api/admin/users/[id]/permissions/[permission] — revoke", () => {
  it("requires permission:grant, same as granting", async () => {
    const actor = await makeUser("MANAGER");
    const target = await makeUser("USER");

    const res = await revokeAs(actor, target.id, "audit:read");

    expect(res.status).toBe(403);
  });

  it("sets revokedAt rather than deleting the row — the audit trail survives", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");
    await grantAs(admin, target.id, { permission: "audit:read" });

    const res = await revokeAs(admin, target.id, "audit:read");
    expect(res.status).toBe(200);

    const grant = await prisma.adminPermissionGrant.findFirstOrThrow({ where: { userId: target.id, permission: "audit:read" } });
    expect(grant.revokedAt).not.toBeNull();
  });

  it("404s revoking a permission the user was never granted", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const res = await revokeAs(admin, target.id, "audit:read");

    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/users/[id]/permissions — effective set, role-derived vs granted", () => {
  it("requires user:read", async () => {
    const actor = await makeUser("USER");
    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: actor.id, email: actor.email, plan: "FREE", role: "USER" as never });

    const res = await getPermissions(req(), ctx(actor.id));
    expect(res.status).toBe(403);
  });

  it("shows role-derived and granted permissions distinctly, and their union as effective", async () => {
    const reader = await makeUser("BILLING_ADMIN"); // has user:read
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("CONTENT_ADMIN"); // role-derived: metrics:read, user:read
    await grantAs(admin, target.id, { permission: "crawl:retry" });

    vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: reader.id, email: reader.email, plan: "FREE", role: "BILLING_ADMIN" as never });
    const res = await getPermissions(req(), ctx(target.id));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(new Set(body.roleDerived)).toEqual(new Set(["metrics:read", "user:read"]));
    expect(body.granted.map((g: { permission: string }) => g.permission)).toEqual(["crawl:retry"]);
    expect(new Set(body.effective)).toEqual(new Set(["metrics:read", "user:read", "crawl:retry"]));
  });
});
