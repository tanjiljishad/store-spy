import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { resolveEntitlement } from "@/lib/control-plane/entitlements";
import { constantTimeEqual } from "@/lib/security/constant-time-equal";

export const runtime = "nodejs"; // Prisma — not available on Edge

/**
 * B3: the single internal endpoint Store Spy calls to decide *entitlement*
 * (never a direct `subscriptions` query, never the payment provider's API,
 * never a plan-name string). Returns the ceiling + whether the subscription
 * grants it; Store Spy still owns the used-vs-quota comparison for numeric
 * quotas — see lib/control-plane/entitlements.ts.
 *
 * Fails CLOSED: no CONTROL_PLANE_INTERNAL_SECRET configured -> 503, same
 * convention as the scheduler routes. This endpoint only reads, but an
 * unauthenticated caller could still enumerate accounts and their plan
 * ceilings.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.CONTROL_PLANE_INTERNAL_SECRET;
  if (!expected) {
    console.error("[internal/entitlements] CONTROL_PLANE_INTERNAL_SECRET is not configured — refusing all requests");
    return Response.json({ error: "Entitlements service is not configured" }, { status: 503 });
  }

  const provided = req.headers.get("x-internal-secret");
  if (!provided || !constantTimeEqual(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("account_id");
  const featureKey = searchParams.get("feature_key");
  if (!accountId || !featureKey) {
    return Response.json({ error: "account_id and feature_key are required" }, { status: 400 });
  }

  const result = await resolveEntitlement(prisma, { accountId, featureKey });
  return Response.json(result);
}
