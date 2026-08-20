import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { assignPromo } from "@/lib/admin/promos-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("promo:assign", async (actor) => {
    const rate = checkRateLimit(`admin:promos:assign:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: promoId } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const targetUserId = isRecord(body) && typeof body.userId === "string" ? body.userId : null;
    if (!targetUserId) {
      return Response.json({ error: "Missing userId" }, { status: 400 });
    }

    const result = await assignPromo(prisma, actor, promoId, targetUserId);
    if (result.outcome === "not_found") {
      return Response.json({ error: "Promo not found." }, { status: 404 });
    }
    return Response.json({ id: promoId, assignedToUserId: targetUserId });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
