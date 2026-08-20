import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/security/rate-limit";
import { constantTimeEqual } from "@/lib/security/constant-time-equal";

export const runtime = "nodejs";

/**
 * TEMPORARY — added to verify TRUSTED_PROXY_HOPS against Render's real
 * proxy topology post-deploy (Milestone 11 staging verification). A
 * removal commit is prepared alongside this one so it can't be forgotten
 * — see the completion report / PR description for when it's safe to
 * apply.
 *
 * Guarded exactly like /api/internal/scheduler/* (fix 1.9): a
 * constant-time secret compare, reusing SCHEDULER_SECRET rather than
 * minting a second secret for a route that exists for about an hour.
 * Fails closed to 404, not 401 — an unauthenticated probe must not even
 * be able to confirm this route exists. What it echoes is otherwise
 * harmless (request-shape info, never app data), but an unauthenticated,
 * public confirmation of this app's proxy topology and getClientIp()
 * behavior is itself worth withholding from anyone who finds the URL.
 */
export async function GET(req: NextRequest) {
  const expected = process.env.SCHEDULER_SECRET;
  const provided = req.headers.get("x-scheduler-secret");
  if (!expected || !provided || !constantTimeEqual(provided, expected)) {
    return new Response(null, { status: 404 });
  }

  return Response.json({
    xForwardedFor: req.headers.get("x-forwarded-for"),
    // Some proxies populate RFC 7239's Forwarded header instead of, or
    // alongside, XFF — checked explicitly rather than assuming XFF alone
    // tells the whole story.
    forwarded: req.headers.get("forwarded"),
    xForwardedHost: req.headers.get("x-forwarded-host"),
    xRealIp: req.headers.get("x-real-ip"),
    computedClientIp: getClientIp(req.headers),
    trustedProxyHopsEnv: process.env.TRUSTED_PROXY_HOPS ?? null,
  });
}
