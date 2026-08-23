import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { startMonitoring, stopMonitoring } from "@/lib/monitoring/watch";
import { limitReached } from "@/lib/entitlements/limit-reached";
import type { PlanTier } from "@/lib/entitlements/plan-limits";

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

  const plan = user.plan as PlanTier;
  const result = await startMonitoring(prisma, user.id, store.id, plan);

  if (result.outcome === "trial_expired") {
    // TRIAL_EXPIRED is a binary state, not a count — current/max are
    // required by the shared LIMIT_REACHED envelope but carry no meaning
    // here; 0/0 is the least-misleading filler the shape allows.
    return Response.json(
      limitReached({ limit: "TRIAL_EXPIRED", current: 0, max: 0, plan }),
      { status: 403 },
    );
  }
  if (result.outcome === "limit_reached") {
    return Response.json(
      limitReached({ limit: "MONITORED_STORES", current: result.current, max: result.max, plan }),
      { status: 403 },
    );
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
