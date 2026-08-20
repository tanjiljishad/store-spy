import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { updateUserRole } from "@/lib/admin/users-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { Role } from "@/lib/admin/roles";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const VALID_ROLES: Role[] = ["USER", "ANALYST", "CONTENT_ADMIN", "SUPPORT_ADMIN", "BILLING_ADMIN", "OPS_ADMIN", "SUPER_ADMIN"];

/**
 * The most sensitive write in this app — see docs/milestone-11-security-
 * rbac-promos.md section 2.4 for the five privilege-escalation invariants
 * this (and updateUserRole()) must uphold. Route stays thin: auth + rate
 * limit + parse + delegate, nothing else — every invariant lives in
 * updateUserRole() itself, directly unit/integration testable without an
 * HTTP round trip.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("user:role:write", async (actor) => {
    const rate = checkRateLimit(`admin:role:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: targetUserId } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const role = isRecord(body) && typeof body.role === "string" ? body.role : null;
    if (!role || !VALID_ROLES.includes(role as Role)) {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }

    const result = await updateUserRole(prisma, actor, targetUserId, role as Role);

    switch (result.outcome) {
      case "updated":
        return Response.json({ id: targetUserId, role: result.role });
      case "self_change_forbidden":
        return Response.json({ error: "You cannot change your own role." }, { status: 403 });
      case "role_not_held_by_actor":
        return Response.json({ error: "You cannot grant a role with more permissions than your own." }, { status: 403 });
      case "super_admin_not_grantable":
        return Response.json({ error: "SUPER_ADMIN cannot be granted through this route." }, { status: 403 });
      case "last_super_admin":
        return Response.json({ error: "Cannot demote the last remaining SUPER_ADMIN." }, { status: 403 });
      case "user_not_found":
        return Response.json({ error: "User not found." }, { status: 404 });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
