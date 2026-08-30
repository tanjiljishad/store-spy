import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Session is mocked at the getCurrentUser seam (the real module pulls in
// next-auth, which doesn't resolve under vitest ESM). requireUser /
// requireVerifiedUser are re-implemented here to MATCH the real ones —
// requireVerifiedUser (audit fix M-3) runs the same needsEmailVerification()
// check against the real test DB, so the checkout gate is genuinely exercised.
const { mockGetCurrentUser } = vi.hoisted(() => ({ mockGetCurrentUser: vi.fn() }));
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
  class EmailNotVerifiedError extends Error {
    constructor() {
      super("Email not verified");
      this.name = "EmailNotVerifiedError";
    }
  }
  const requireUser = async () => {
    const user = await mockGetCurrentUser();
    if (!user) throw new UnauthorizedError();
    return user;
  };
  const requireVerifiedUser = async () => {
    const user = await requireUser();
    const { prisma } = await import("@/lib/db/prisma");
    const { needsEmailVerification } = await import("@/lib/account/email-verification");
    if (await needsEmailVerification(prisma, user.id)) throw new EmailNotVerifiedError();
    return user;
  };
  return { getCurrentUser: mockGetCurrentUser, requireUser, requireVerifiedUser, UnauthorizedError, ForbiddenError, EmailNotVerifiedError };
});

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { POST as validatePromo } from "../../../app/api/billing/promo/validate/route";
import { POST as checkout } from "../../../app/api/billing/checkout/route";
import { GET as listPromos, POST as createPromo } from "../../../app/api/admin/promos/route";
import { POST as assignPromo } from "../../../app/api/admin/promos/[id]/assign/route";
import { POST as revokePromo } from "../../../app/api/admin/promos/[id]/revoke/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AdminAuditLog","PromoRedemption","PromoCode","Checkout","Subscription" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  await resetControlPlane(prisma);
});

afterEach(() => {
  mockGetCurrentUser.mockReset();
});

async function makeUser(role: "USER" | "SUPER_ADMIN" | "BILLING_ADMIN" = "USER", verified = true) {
  // Audit fix M-3: POST /api/billing/checkout now requires a verified email.
  return makeStoreSpyUser(prisma, {
    email: `${randomUUID()}@example.com`,
    role,
    emailVerified: verified ? new Date() : null,
  });
}
/** The account's current tier, from the control-plane subscription (B2 2·B). */
async function currentPlan(userId: string): Promise<string> {
  const sub = await prisma.cpSubscription.findFirstOrThrow({
    where: { accountId: `acct_${userId}`, status: { in: ["ACTIVE", "TRIALING"] } },
    orderBy: { createdAt: "desc" },
    select: { planSlug: true },
  });
  return sub.planSlug!;
}
function signInAs(user: { id: string; email: string; role: string }) {
  mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, role: user.role as never });
}
function req(url2: string, body?: unknown) {
  return new NextRequest(`http://localhost${url2}`, {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.40", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/billing/promo/validate", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await validatePromo(req("/api/billing/promo/validate", { plan: "BASIC", period: "MONTHLY", code: "X" }));
    expect(res.status).toBe(401);
  });

  it("never leaks WHY a code is invalid — not_found and not_assigned_to_you look identical", async () => {
    const owner = await makeUser();
    const otherUser = await makeUser();
    const admin = await makeUser("SUPER_ADMIN");
    const promo = await prisma.promoCode.create({
      data: {
        code: "ASSIGNEDONE1",
        discountType: "PERCENT",
        discountValue: 100,
        validFrom: new Date(Date.now() - 1000),
        assignedToUserId: owner.id,
        createdByUserId: admin.id,
      },
    });

    signInAs(otherUser);
    const wrongUserRes = await validatePromo(req("/api/billing/promo/validate", { plan: "BASIC", period: "MONTHLY", code: promo.code }));
    const wrongUserBody = await wrongUserRes.json();

    signInAs(otherUser);
    const fakeCodeRes = await validatePromo(req("/api/billing/promo/validate", { plan: "BASIC", period: "MONTHLY", code: "NOSUCHCODE99" }));
    const fakeCodeBody = await fakeCodeRes.json();

    expect(wrongUserRes.status).toBe(fakeCodeRes.status);
    expect(wrongUserBody).toEqual(fakeCodeBody);
    expect(wrongUserBody.ok).toBe(false);
  });

  it("returns the computed total for a valid code", async () => {
    const user = await makeUser();
    const admin = await makeUser("SUPER_ADMIN");
    const promo = await prisma.promoCode.create({
      data: { code: "HALFOFF1234", discountType: "PERCENT", discountValue: 50, validFrom: new Date(Date.now() - 1000), createdByUserId: admin.id },
    });
    signInAs(user);
    const res = await validatePromo(req("/api/billing/promo/validate", { plan: "BASIC", period: "MONTHLY", code: promo.code }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.finalCents).toBe(body.listPriceCents - body.discountCents);
  });
});

describe("POST /api/billing/checkout", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await checkout(req("/api/billing/checkout", { plan: "BASIC", period: "MONTHLY" }));
    expect(res.status).toBe(401);
  });

  // Audit fix M-3: an unverified signed-in account cannot check out.
  it("403s a signed-in but unverified account", async () => {
    const user = await makeUser("USER", /* verified */ false);
    signInAs(user);
    const res = await checkout(req("/api/billing/checkout", { plan: "BASIC", period: "MONTHLY" }));
    expect(res.status).toBe(403);
  });

  it("a 100% code completes checkout and grants the plan for real, over HTTP", async () => {
    const user = await makeUser();
    const admin = await makeUser("SUPER_ADMIN");
    const promo = await prisma.promoCode.create({
      data: { code: "FULLFREE1234", discountType: "PERCENT", discountValue: 100, validFrom: new Date(Date.now() - 1000), createdByUserId: admin.id },
    });
    signInAs(user);
    const res = await checkout(req("/api/billing/checkout", { plan: "BASIC", period: "MONTHLY", code: promo.code }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "completed", plan: "BASIC" });

    expect(await currentPlan(user.id)).toBe("BASIC");
  });

  it("rejects a client-supplied price — the body has no price field the server ever reads", async () => {
    const user = await makeUser();
    signInAs(user);
    const res = await checkout(
      req("/api/billing/checkout", { plan: "BASIC", period: "MONTHLY", finalCents: 1, listPriceCents: 1 } as never),
    );
    // The route only ever reads plan/period/code from the body — extra
    // fields are silently ignored, never trusted. A no-code checkout still
    // computes the real server-side price.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.finalCents).toBeGreaterThan(1);
  });
});

describe("POST /api/admin/promos (create)", () => {
  it("403s a caller without promo:create (e.g. BILLING_ADMIN, which only has promo:read)", async () => {
    const actor = await makeUser("BILLING_ADMIN");
    signInAs(actor);
    const res = await createPromo(
      req("/api/admin/promos", { discountType: "PERCENT", discountValue: 50, validFrom: new Date().toISOString() }),
    );
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN creates a promo and gets the full code back once", async () => {
    const actor = await makeUser("SUPER_ADMIN");
    signInAs(actor);
    const res = await createPromo(
      req("/api/admin/promos", {
        discountType: "PERCENT",
        discountValue: 100,
        validFrom: new Date().toISOString(),
        durationDays: 30,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toBeDefined();

    const auditRows = await prisma.adminAuditLog.count({ where: { action: "promo.create" } });
    expect(auditRows).toBe(1);
  });

  it("rejects an out-of-range percent discount", async () => {
    const actor = await makeUser("SUPER_ADMIN");
    signInAs(actor);
    const res = await createPromo(
      req("/api/admin/promos", { discountType: "PERCENT", discountValue: 150, validFrom: new Date().toISOString() }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects validUntil before validFrom", async () => {
    const actor = await makeUser("SUPER_ADMIN");
    signInAs(actor);
    const res = await createPromo(
      req("/api/admin/promos", {
        discountType: "PERCENT",
        discountValue: 50,
        validFrom: new Date(2026, 0, 10).toISOString(),
        validUntil: new Date(2026, 0, 1).toISOString(),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/admin/promos (list)", () => {
  it("BILLING_ADMIN can list (promo:read) even though it cannot create", async () => {
    const actor = await makeUser("BILLING_ADMIN");
    signInAs(actor);
    const res = await listPromos(new NextRequest("http://localhost/api/admin/promos", { headers: { "x-forwarded-for": "203.0.113.41" } }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/promos/[id]/assign and /revoke", () => {
  it("assigns and then revokes a promo, both writing audit rows", async () => {
    const admin = await makeUser("SUPER_ADMIN");
    const target = await makeUser("USER");
    const promo = await prisma.promoCode.create({
      data: { code: "ASSIGNTEST12", discountType: "PERCENT", discountValue: 50, validFrom: new Date(), createdByUserId: admin.id },
    });

    signInAs(admin);
    const assignRes = await assignPromo(req("/x", { userId: target.id }), ctx(promo.id));
    expect(assignRes.status).toBe(200);
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).assignedToUserId).toBe(target.id);

    const revokeRes = await revokePromo(req("/x"), ctx(promo.id));
    expect(revokeRes.status).toBe(200);
    expect((await prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).status).toBe("DISABLED");

    const auditRows = await prisma.adminAuditLog.count({ where: { targetId: promo.id } });
    expect(auditRows).toBe(2); // assign + revoke
  });
});
