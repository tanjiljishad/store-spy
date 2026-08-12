import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { buildGrowthReport } from "@/lib/growth/report";

/**
 * Growth signals (catalog growth, bestseller movement, review
 * infrastructure, product freshness) for a store. Same access shape as
 * GET /api/store/[domain]/marketing and /activity: store-scoped, not
 * user-scoped, no plan/entitlement gate — see growth/report.ts.
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const rate = checkRateLimit(`growth:${getClientIp(req.headers)}`, RATE_LIMIT);
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

  const report = await buildGrowthReport(prisma, store.id, domain);
  return Response.json(report);
}
