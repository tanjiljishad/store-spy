import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { computeGrowthSignals, getActivitySummary } from "@/lib/monitoring/activity";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveStoreAccess } from "@/lib/auth/store-access";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const MAX_WINDOW_DAYS = 90;

export async function GET(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const user = await getCurrentUser();
  const rateKey = user ? `activity:user:${user.id}` : `activity:ip:${getClientIp(req.headers)}`;
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
    return Response.json({ error: "Sign in to view this store's activity." }, { status: 401 });
  }
  if (access === "unanalyzed_preview") {
    return Response.json({ error: "Analyze this store first to view its activity.", code: "STORE_NOT_ANALYZED" }, { status: 403 });
  }

  const url = new URL(req.url);
  const windowParam = url.searchParams.get("windowDays");
  const windowDays = Math.max(1, Math.min(windowParam ? Number(windowParam) || 7 : 7, MAX_WINDOW_DAYS));

  const summary = await getActivitySummary(prisma, store.id, windowDays);
  const signals = computeGrowthSignals(summary);

  return Response.json({ summary, signals });
}
