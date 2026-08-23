import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { getEffectivePermissionsForUser, grantPermission, isKnownPermission } from "@/lib/admin/permissions-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/** Effective set for a user — role-derived vs granted, and their union. Requires user:read (this milestone's doc, §2.4). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("user:read", async (actor) => {
    const rate = checkRateLimit(`admin:permissions:read:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: targetUserId } = await params;
    const result = await getEffectivePermissionsForUser(prisma, targetUserId);
    if (!result) {
      return Response.json({ error: "User not found." }, { status: 404 });
    }
    return Response.json(result);
  });
}

/**
 * Grants one permission. Requires permission:grant — itself SUPER_ADMIN_ONLY
 * (roles.ts), so in practice only a SUPER_ADMIN ever reaches this handler.
 * Every privilege-escalation invariant lives in grantPermission() itself,
 * directly unit/integration testable without an HTTP round trip — this
 * route stays thin: auth + rate limit + parse + delegate.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("permission:grant", async (actor) => {
    const rate = checkRateLimit(`admin:permissions:grant:user:${actor.id}`, RATE_LIMIT);
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

    const permission = isRecord(body) && typeof body.permission === "string" ? body.permission : null;
    if (!permission || !isKnownPermission(permission)) {
      return Response.json({ error: "Invalid permission" }, { status: 400 });
    }

    let expiresAt: Date | null = null;
    if (isRecord(body) && body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string") {
        return Response.json({ error: "Invalid expiresAt" }, { status: 400 });
      }
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return Response.json({ error: "Invalid expiresAt" }, { status: 400 });
      }
      expiresAt = parsed;
    }

    const result = await grantPermission(prisma, actor, targetUserId, permission, expiresAt);

    switch (result.outcome) {
      case "granted":
        return Response.json({ permission, grantedAt: result.grantedAt.toISOString(), expiresAt: result.expiresAt?.toISOString() ?? null });
      case "already_granted":
        return Response.json({ permission, status: "already_granted" });
      case "self_grant_forbidden":
        return Response.json({ error: "You cannot grant a permission to yourself." }, { status: 403 });
      case "super_admin_only_permission":
        return Response.json({ error: "This permission can only be held by SUPER_ADMIN, and cannot be granted." }, { status: 403 });
      case "user_not_found":
        return Response.json({ error: "User not found." }, { status: 404 });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
