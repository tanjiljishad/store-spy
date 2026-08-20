import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { getUserDetail } from "@/lib/admin/users-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("user:read", async (actor) => {
    const rate = checkRateLimit(`admin:user-detail:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id } = await params;
    const detail = await getUserDetail(prisma, id);
    if (!detail) {
      return Response.json({ error: "User not found." }, { status: 404 });
    }
    return Response.json(detail);
  });
}
