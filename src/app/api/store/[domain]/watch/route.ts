import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { startMonitoring, stopMonitoring } from "@/lib/monitoring/watch";

/**
 * Starts/stops the CALLER's monitoring relationship with a store. Requires
 * a signed-in user — there is no anonymous monitoring. userId/plan/ownership
 * are derived entirely server-side from the session; nothing here trusts a
 * client-supplied identity (section 59/91 of the spec).
 */
export const runtime = "nodejs";

const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

async function resolveStore(rawDomain: string) {
  const domain = canonicalizeDomain(decodeURIComponent(rawDomain));
  return prisma.store.findUnique({ where: { domain }, select: { id: true } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const rate = checkRateLimit(`watch:${getClientIp(req.headers)}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Sign in to monitor a store." }, { status: 401 });
  }

  const { domain: rawDomain } = await params;
  const store = await resolveStore(rawDomain);
  if (!store) {
    return Response.json({ error: "Store not found" }, { status: 404 });
  }

  const result = await startMonitoring(prisma, user.id, store.id, user.plan);

  if (result.outcome === "limit_reached") {
    return Response.json({ code: result.code, capability: result.capability }, { status: 403 });
  }
  return Response.json({
    status: "ACTIVE",
    // null means no commercial monitoring expiry.
    expiresAt: result.expiresAt?.toISOString() ?? null,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ domain: string }> }) {
  const rate = checkRateLimit(`watch:${getClientIp(req.headers)}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }

  const { domain: rawDomain } = await params;
  const store = await resolveStore(rawDomain);
  if (!store) {
    return Response.json({ error: "Store not found" }, { status: 404 });
  }

  await stopMonitoring(prisma, user.id, store.id);
  return Response.json({ status: "REMOVED" });
}
