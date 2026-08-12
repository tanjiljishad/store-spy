import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getChangeFeed } from "@/lib/monitoring/change-feed";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 }; // read-only, more generous than /api/analyze

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const rate = checkRateLimit(`events:${getClientIp(req.headers)}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  const { domain: rawDomain } = await params;
  const domain = canonicalizeDomain(decodeURIComponent(rawDomain));

  const store = await prisma.store.findUnique({ where: { domain }, select: { id: true } });
  if (!store) {
    return Response.json({ error: "Store not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const typesParam = url.searchParams.get("types");

  const page = await getChangeFeed(prisma, store.id, {
    cursor: cursor ?? undefined,
    limit: limitParam ? Number(limitParam) : undefined,
    eventTypes: typesParam ? typesParam.split(",").filter(Boolean) : undefined,
  });

  return Response.json(page);
}
