import type { NextRequest } from "next/server";
import { handlers } from "../../../../lib/auth/auth";
import { checkRateLimit, getClientIp } from "../../../../lib/security/rate-limit";

export const runtime = "nodejs"; // Prisma + bcrypt both need Node, not Edge

/**
 * A cheap first line in front of Auth.js itself, scoped to the one path
 * that actually spends bcrypt CPU (~250ms/call at cost 12) and touches the
 * database-backed login throttle (see login-throttle.ts, wired into
 * auth.ts's authorize()) — that throttle is the real defense against
 * sustained/distributed guessing, but this in-memory limiter stops a burst
 * from a single IP before Auth.js is even invoked, at effectively zero
 * cost. `GET` (session/provider/CSRF reads) is deliberately left unwrapped
 * — those are hot, harmless, and unrelated to credential guessing.
 */
const CREDENTIALS_CALLBACK_PATH = "/api/auth/callback/credentials";
const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

export async function POST(req: NextRequest) {
  if (req.nextUrl.pathname === CREDENTIALS_CALLBACK_PATH) {
    const rate = checkRateLimit(`auth-credentials:${getClientIp(req.headers)}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json(
        { error: "Too many sign-in attempts. Try again shortly." },
        { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } },
      );
    }
  }
  return handlers.POST(req);
}

export const { GET } = handlers;
