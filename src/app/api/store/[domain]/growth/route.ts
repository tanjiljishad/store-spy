import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveStoreAccess } from "@/lib/auth/store-access";
import { buildGrowthReport } from "@/lib/growth/report";

/**
 * Growth signals (catalog growth, bestseller movement, review
 * infrastructure, product freshness) for a store. Gated the same way as
 * /events, /activity, and /marketing: `full` access only, via
 * resolveStoreAccess() — see store-access.ts for why this is no longer a
 * store-scoped-but-otherwise-public endpoint.
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const user = await getCurrentUser();
  const rateKey = user ? `growth:user:${user.id}` : `growth:ip:${getClientIp(req.headers)}`;
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

  const access = await resolveStoreAccess(prisma, store.id, user);
  if (access === "anonymous_preview") {
    return Response.json({ error: "Sign in to view this store's growth signals." }, { status: 401 });
  }
  if (access === "unanalyzed_preview") {
    return Response.json({ error: "Analyze this store first to view its growth signals.", code: "STORE_NOT_ANALYZED" }, { status: 403 });
  }

  const report = await buildGrowthReport(prisma, store.id, domain);
  return Response.json(report);
}
