import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { exportUsersWithAudit, toCsv, type ExportPurpose } from "@/lib/admin/analytics/user-export";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { Role } from "@/lib/admin/roles";

export const runtime = "nodejs";

// Bulk export — far tighter than the read-only GET /api/admin/users (60/min):
// this is the route the doc singles out as needing to be "audited more
// loudly" than a lookup, and a low ceiling limits how much of that audit
// trail one compromised/misbehaving admin session can generate.
const RATE_LIMIT = { limit: 5, windowMs: 60_000 };
const VALID_PLANS: PlanTier[] = ["FREE", "BASIC", "BUSINESS"];
const VALID_ROLES: Role[] = [
  "USER",
  "ANALYST",
  "CONTENT_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
  "OPS_ADMIN",
  "MARKETING_ADMIN",
  "MANAGER",
  "SUPER_ADMIN",
];

/**
 * Milestone 12 Section 3.3: requires export:users, NOT user:read — a
 * SUPER_ADMIN_ONLY-adjacent but separately grantable permission (see
 * roles.ts), deliberately distinct from the plain read gate GET
 * /api/admin/users uses. purpose:"marketing" now filters to
 * `marketingConsent = true` (Milestone 12 §4.1) — see
 * exportUsersWithAudit()'s own doc comment.
 */
export async function POST(req: NextRequest) {
  return withAdminRoute("export:users", async (actor) => {
    const rate = checkRateLimit(`admin:users:export:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    if (!isRecord(body) || typeof body.purpose !== "string") {
      return Response.json({ error: 'purpose is required ("support" or "marketing")' }, { status: 400 });
    }
    const purpose = body.purpose;
    if (purpose !== "support" && purpose !== "marketing") {
      return Response.json({ error: 'purpose must be "support" or "marketing"' }, { status: 400 });
    }

    const plan = typeof body.plan === "string" ? body.plan : undefined;
    if (plan !== undefined && !VALID_PLANS.includes(plan as PlanTier)) {
      return Response.json({ error: "Invalid plan filter" }, { status: 400 });
    }
    const role = typeof body.role === "string" ? body.role : undefined;
    if (role !== undefined && !VALID_ROLES.includes(role as Role)) {
      return Response.json({ error: "Invalid role filter" }, { status: 400 });
    }
    const emailQuery = typeof body.emailQuery === "string" ? body.emailQuery : undefined;

    const result = await exportUsersWithAudit(
      prisma,
      actor,
      { plan: plan as PlanTier | undefined, role: role as Role | undefined, emailQuery },
      purpose as ExportPurpose,
    );

    const csv = toCsv(result.rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="users-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
