import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The five privilege-escalation invariants from docs/milestone-11-security-
 * rbac-promos.md section 2.4, written FIRST per the doc's own instruction —
 * these fail (the route doesn't exist yet) until Phase 2's role route is
 * actually built. Full synthetic mock of @/lib/auth/session, same reason
 * as store-access.integration.test.ts: loading the real next-auth chain
 * inside vitest's SSR module loader hits an unrelated ESM-resolution issue
 * in next-auth's own "next/server" import. admin/guard.ts (which the role
 * route goes through) needs requireUser() and both error classes from this
 * same module, not just getCurrentUser() — reimplemented here verbatim
 * (they're simple, dependency-free) rather than importOriginal()'d, which
 * would pull the real chain back in.
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
import { PATCH as patchRole } from "../../../app/api/admin/users/[id]/role/route";
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
  await prisma.$executeRawUnsafe(`TRUNCATE "AdminAuditLog","Session","Account","User" RESTART IDENTITY CASCADE`);
  _resetRateLimitState();
  await resetControlPlane(prisma);
});

async function makeUser(role: "USER" | "ANALYST" | "SUPPORT_ADMIN" | "SUPER_ADMIN" = "USER") {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, role });
}

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/users/x/role", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Fires `patchRole` as `actor` targeting `targetId` — signs in fresh right before the call, since mocks are shared, not per-request. */
async function patchAs(actor: { id: string; email: string; role: string }, targetId: string, body: unknown) {
  vi.mocked(getCurrentUser).mockResolvedValueOnce({ id: actor.id, email: actor.email, plan: "FREE", role: actor.role as never });
  return patchRole(req(body), ctx(targetId));
}

describe("PATCH /api/admin/users/[id]/role — privilege-escalation invariants", () => {
  it("1. an actor can never change their own role, even SUPER_ADMIN", async () => {
    const admin = await makeUser("SUPER_ADMIN");

    const res = await patchAs(admin, admin.id, { role: "SUPPORT_ADMIN" });

    expect(res.status).toBe(403);
    expect((await prisma.userAdminRole.findUnique({ where: { userId: admin.id } }))?.role).toBe("SUPER_ADMIN");
  });

  it("2. an actor lacking user:role:write cannot grant any role at all (generic permission gate, not a hardcoded role name)", async () => {
    const actor = await makeUser("SUPPORT_ADMIN"); // no user:role:write in the matrix
    const target = await makeUser("USER");

    const res = await patchAs(actor, target.id, { role: "OPS_ADMIN" });

    expect(res.status).toBe(403);
    // "USER" == no store_spy.UserAdminRole row.
    expect(await prisma.userAdminRole.findUnique({ where: { userId: target.id } })).toBeNull();
  });

  it("3. the last remaining SUPER_ADMIN cannot be demoted — even under a genuine concurrent race", async () => {
    // The only way to observe this invariant as a race (rather than as a
    // restatement of invariant 1) is two SUPER_ADMINs demoting EACH OTHER
    // at the same instant: a check-then-write race would let both
    // transactions read "count = 2" before either commits, and both would
    // then proceed, leaving zero. The pg_advisory_xact_lock must serialize
    // them so the second to acquire it sees the FIRST's already-committed
    // demotion and correctly refuses.
    const adminA = await makeUser("SUPER_ADMIN");
    const adminB = await makeUser("SUPER_ADMIN");

    const [resAtoB, resBtoA] = await Promise.all([
      patchAs(adminA, adminB.id, { role: "SUPPORT_ADMIN" }),
      patchAs(adminB, adminA.id, { role: "SUPPORT_ADMIN" }),
    ]);

    const statuses = [resAtoB.status, resBtoA.status].sort();
    expect(statuses).toEqual([200, 403]); // exactly one succeeds, one is rejected

    const remainingSuperAdmins = await prisma.userAdminRole.count({ where: { role: "SUPER_ADMIN" } });
    expect(remainingSuperAdmins).toBe(1); // never zero
  });

  it("4. SUPER_ADMIN cannot be granted through this (or any) HTTP route", async () => {
    const actor = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");

    const res = await patchAs(actor, target.id, { role: "SUPER_ADMIN" });

    expect(res.status).toBe(403);
    // "USER" == no store_spy.UserAdminRole row.
    expect(await prisma.userAdminRole.findUnique({ where: { userId: target.id } })).toBeNull();
  });
});
