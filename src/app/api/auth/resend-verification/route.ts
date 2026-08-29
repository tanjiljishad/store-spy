import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { sendVerificationEmail } from "@/lib/email/verification-email";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 3, windowMs: 60_000 };

/**
 * The /verify-email interstitial's "resend" button target. Requires a
 * signed-in session (unlike the signup route, this account already exists)
 * — same requireUser() pattern as /api/account/consent.
 */
export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const rate = checkRateLimit(`auth:resend-verification:${actor.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }

  // Fresh read, not the JWT-cached actor — emailVerifiedAt isn't a session claim.
  const fresh = await prisma.cpUser.findUnique({ where: { id: actor.id }, select: { email: true, emailVerifiedAt: true } });
  if (!fresh) return Response.json({ error: "Account not found." }, { status: 404 });
  if (fresh.emailVerifiedAt) return Response.json({ status: "already_verified" });

  try {
    await sendVerificationEmail(req.nextUrl.origin, actor.id, fresh.email);
  } catch (e) {
    console.error("[api/auth/resend-verification] sendVerificationEmail failed:", e);
    return Response.json({ error: "Could not send the email right now. Please try again shortly." }, { status: 502 });
  }

  return Response.json({ status: "sent" });
}
