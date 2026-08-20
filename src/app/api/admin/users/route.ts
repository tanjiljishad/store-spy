import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { searchUsers } from "@/lib/admin/users-service";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 }; // read-only, more generous than the write routes

export async function GET(req: NextRequest) {
  return withAdminRoute("user:read", async (actor) => {
    const rate = checkRateLimit(`admin:users:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const url = new URL(req.url);
    const emailQuery = url.searchParams.get("email") ?? undefined;
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");

    const page = await searchUsers(prisma, {
      emailQuery,
      cursor: cursor ?? undefined,
      limit: limitParam ? Number(limitParam) : undefined,
    });

    return Response.json(page);
  });
}
