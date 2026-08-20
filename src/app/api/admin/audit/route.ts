import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { getAuditLog } from "@/lib/admin/audit";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Append-only — no update or delete path exists anywhere in the code (see audit.ts). */
export async function GET(req: NextRequest) {
  return withAdminRoute("audit:read", async (actor) => {
    const rate = checkRateLimit(`admin:audit:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");

    const page = await getAuditLog(prisma, { cursor: cursor ?? undefined, limit: limitParam ? Number(limitParam) : undefined });
    return Response.json(page);
  });
}
