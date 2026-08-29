import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { GET as listUsers } from "../../../app/api/admin/users/route";
import { GET as userDetail } from "../../../app/api/admin/users/[id]/route";
import { PATCH as patchPlan } from "../../../app/api/admin/users/[id]/plan/route";
import { POST as revokeSessions } from "../../../app/api/admin/users/[id]/revoke-sessions/route";
import { GET as auditLog } from "../../../app/api/admin/audit/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","AnalysisUsage","Watchlist","Session","Account","User","Store" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  await resetControlPlane(prisma);
});

afterEach(() => {
  vi.mocked(getCurrentUser).mockReset();
});

async function makeUser(role: "USER" | "SUPPORT_ADMIN" | "BILLING_ADMIN" | "SUPER_ADMIN" = "USER", email?: string) {
  return makeStoreSpyUser(prisma, { email: email ?? `${randomUUID()}@example.com`, role });
}

function signInAs(user: { id: string; email: string; role: string }) {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, plan: "FREE", role: user.role as never });
}

function req(url2: string, init: { method?: string; body?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost${url2}`, {
    method: init.method,
    body: init.body,
    headers: { "x-forwarded-for": "203.0.113.20", "content-type": "application/json" },
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/admin/users", () => {
  it("401s an anonymous caller", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await listUsers(req("/api/admin/users"));
    expect(res.status).toBe(401);
  });

  it("403s a caller without user:read", async () => {
    const actor = await makeUser("USER");
    signInAs(actor);
    const res = await listUsers(req("/api/admin/users"));
    expect(res.status).toBe(403);
  });

  it("searches by email substring, case-insensitively", async () => {
    const actor = await makeUser("SUPPORT_ADMIN");
    signInAs(actor);
    await makeUser("USER", "distinctive-target@example.com");
    await makeUser("USER", "unrelated@example.com");

    const res = await listUsers(req("/api/admin/users?email=DISTINCTIVE"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].email).toBe("distinctive-target@example.com");
  });
});

describe("GET /api/admin/users/[id]", () => {
  it("404s an unknown user", async () => {
    const actor = await makeUser("SUPPORT_ADMIN");
    signInAs(actor);
    const res = await userDetail(req("/api/admin/users/nope"), ctx("nonexistent-id"));
    expect(res.status).toBe(404);
  });

  it("returns plan, role, and usage/watch counts", async () => {
    const actor = await makeUser("SUPPORT_ADMIN");
    signInAs(actor);
    const target = await makeUser("USER");

    const res = await userDetail(req("/api/admin/users/x"), ctx(target.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: target.id, plan: "FREE", role: "USER", analysesUsed: 0, activeWatchCount: 0 });
  });
});

describe("PATCH /api/admin/users/[id]/plan", () => {
  it("403s a caller without user:plan:write", async () => {
    const actor = await makeUser("SUPPORT_ADMIN"); // has user:read/suspend, not plan:write
    signInAs(actor);
    const target = await makeUser("USER");

    const res = await patchPlan(req("/x", { method: "PATCH", body: JSON.stringify({ plan: "BASIC" }) }), ctx(target.id));
    expect(res.status).toBe(403);
  });

  it("rejects an invalid plan value", async () => {
    const actor = await makeUser("BILLING_ADMIN");
    signInAs(actor);
    const target = await makeUser("USER");

    const res = await patchPlan(req("/x", { method: "PATCH", body: JSON.stringify({ plan: "GOLD_TIER" } as never) }), ctx(target.id));
    expect(res.status).toBe(400);
  });

  it("updates the plan and writes an audit row", async () => {
    const actor = await makeUser("BILLING_ADMIN");
    signInAs(actor);
    const target = await makeUser("USER");

    const res = await patchPlan(req("/x", { method: "PATCH", body: JSON.stringify({ plan: "BASIC" }) }), ctx(target.id));
    expect(res.status).toBe(200);

    const sub = await prisma.cpSubscription.findFirstOrThrow({ where: { accountId: `acct_${target.id}`, status: "ACTIVE" }, select: { planSlug: true } });
    expect(sub.planSlug).toBe("BASIC");
    const auditRows = await prisma.adminAuditLog.count({ where: { targetId: target.id, action: "user.plan.update" } });
    expect(auditRows).toBe(1);
  });
});

describe("POST /api/admin/users/[id]/revoke-sessions", () => {
  it("403s a caller without user:suspend", async () => {
    const actor = await makeUser("BILLING_ADMIN"); // no user:suspend
    signInAs(actor);
    const target = await makeUser("USER");

    const res = await revokeSessions(req("/x", { method: "POST" }), ctx(target.id));
    expect(res.status).toBe(403);
  });

  it("sets sessionsValidAfter and writes an audit row", async () => {
    const actor = await makeUser("SUPPORT_ADMIN");
    signInAs(actor);
    const target = await makeUser("USER");

    const res = await revokeSessions(req("/x", { method: "POST" }), ctx(target.id));
    expect(res.status).toBe(200);

    const updated = await prisma.cpUser.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.sessionsValidAfter).not.toBeNull();
    const auditRows = await prisma.adminAuditLog.count({ where: { targetId: target.id, action: "user.sessions.revoke" } });
    expect(auditRows).toBe(1);
  });
});

describe("GET /api/admin/audit", () => {
  it("requires audit:read — SUPPORT_ADMIN (no audit:read) gets 403", async () => {
    const actor = await makeUser("SUPPORT_ADMIN");
    signInAs(actor);
    const res = await auditLog(req("/api/admin/audit"));
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN can read the audit log, cursor-paginated", async () => {
    const actor = await makeUser("SUPER_ADMIN");
    signInAs(actor);
    const target = await makeUser("USER");
    await revokeSessions(req("/x", { method: "POST" }), ctx(target.id));

    const res = await auditLog(req("/api/admin/audit"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toMatchObject({ action: "user.sessions.revoke", targetType: "User" });
  });
});
