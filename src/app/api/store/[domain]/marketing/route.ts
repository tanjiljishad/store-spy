import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveStoreAccess } from "@/lib/auth/store-access";
import { buildMarketingReport } from "@/lib/marketing/report";

/**
 * Current-state marketing (Google advertising) intelligence for a store.
 * Gated the same way as /events, /activity, and /growth: `full` access
 * only, via resolveStoreAccess() — see store-access.ts. This is real,
 * billed SerpApi-derived data; giving it away to anyone who knows a domain
 * made every other route's gate decorative.
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const user = await getCurrentUser();
  const rateKey = user ? `marketing:user:${user.id}` : `marketing:ip:${getClientIp(req.headers)}`;
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
    return Response.json({ error: "Sign in to view this store's advertising intelligence." }, { status: 401 });
  }
  if (access === "unanalyzed_preview") {
    return Response.json(
      { error: "Analyze this store first to view its advertising intelligence.", code: "STORE_NOT_ANALYZED" },
      { status: 403 },
    );
  }

  const report = await buildMarketingReport(prisma, store.id, domain);
  return Response.json(report);
}
