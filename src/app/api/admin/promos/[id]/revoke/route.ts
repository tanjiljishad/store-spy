import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { revokePromo } from "@/lib/admin/promos-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

/** Sets status DISABLED. Never deletes. Does NOT claw back a plan already granted via a completed checkout — see this milestone's doc, §3.5. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("promo:revoke", async (actor) => {
    const rate = checkRateLimit(`admin:promos:revoke:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: promoId } = await params;
    const result = await revokePromo(prisma, actor, promoId);
    if (result.outcome === "not_found") {
      return Response.json({ error: "Promo not found." }, { status: 404 });
    }
    return Response.json({
      id: promoId,
      status: "DISABLED",
      note: "Revoking a promo does not claw back a plan already granted through it.",
    });
  });
}
