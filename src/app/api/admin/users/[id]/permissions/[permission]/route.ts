import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { isKnownPermission, revokePermission } from "@/lib/admin/permissions-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/** Revoke — sets revokedAt, never deletes (see AdminPermissionGrant's own schema.prisma doc comment). Requires permission:grant, same as granting. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; permission: string }> }) {
  return withAdminRoute("permission:grant", async (actor) => {
    const rate = checkRateLimit(`admin:permissions:revoke:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: targetUserId, permission: rawPermission } = await params;
    const permission = decodeURIComponent(rawPermission);
    if (!isKnownPermission(permission)) {
      return Response.json({ error: "Invalid permission" }, { status: 400 });
    }

    const result = await revokePermission(prisma, actor, targetUserId, permission);
    if (result.outcome === "not_found") {
      return Response.json({ error: "No active grant of this permission for this user." }, { status: 404 });
    }
    return Response.json({ permission, status: "revoked" });
  });
}
