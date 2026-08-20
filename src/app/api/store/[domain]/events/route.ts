import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getChangeFeed } from "@/lib/monitoring/change-feed";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveStoreAccess } from "@/lib/auth/store-access";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 }; // read-only, more generous than /api/analyze

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const user = await getCurrentUser();
  // Per-account limits aren't spoofable the way an IP is — use userId once
  // we have one, and only fall back to IP for an anonymous caller.
  const rateKey = user ? `events:user:${user.id}` : `events:ip:${getClientIp(req.headers)}`;
  const rate = checkRateLimit(rateKey, RATE_LIMIT);
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

  // All-or-nothing, never a partial payload: the change feed is exactly the
  // kind of vendor-paid/derived data an anonymous or not-yet-analyzed
  // caller must not be able to pull for free (see store-access.ts).
  const access = await resolveStoreAccess(prisma, store.id, user);
  if (access === "anonymous_preview") {
    return Response.json({ error: "Sign in to view this store's change feed." }, { status: 401 });
  }
  if (access === "unanalyzed_preview") {
    return Response.json({ error: "Analyze this store first to view its change feed.", code: "STORE_NOT_ANALYZED" }, { status: 403 });
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
