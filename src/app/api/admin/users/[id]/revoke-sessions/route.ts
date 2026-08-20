import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { revokeUserSessions } from "@/lib/admin/users-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/** Sets User.sessionsValidAfter = now() — see jwt-plan-refresh.ts for how the jwt callback enforces it (within 60s for a USER-role token, on the very next request for a privileged one). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("user:suspend", async (actor) => {
    const rate = checkRateLimit(`admin:revoke-sessions:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: targetUserId } = await params;
    const result = await revokeUserSessions(prisma, actor, targetUserId);
    if (result.outcome === "user_not_found") {
      return Response.json({ error: "User not found." }, { status: 404 });
    }
    return Response.json({ id: targetUserId, revoked: true });
  });
}
