import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { recordOAuthWelcomeConsent } from "@/lib/account/consent";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * Milestone 12 §4.1 addendum: the `/welcome` interstitial's submit target —
 * the OAuth-signup equivalent of the credentials signup route's
 * tosAccepted/marketingConsent validation. Same rule: ToS is mandatory,
 * marketing is optional and defaults to false if omitted.
 */
export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const rate = checkRateLimit(`account:consent:${actor.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const tosAccepted = isRecord(body) && body.tosAccepted === true;
  const marketingConsent = isRecord(body) && body.marketingConsent === true;

  if (!tosAccepted) {
    return Response.json({ error: "You must agree to the Terms of Service and Privacy Policy to continue." }, { status: 400 });
  }

  await recordOAuthWelcomeConsent(prisma, actor.id, { marketingConsent });
  return Response.json({ status: "recorded" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
