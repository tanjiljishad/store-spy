import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireVerifiedUser, UnauthorizedError, EmailNotVerifiedError } from "@/lib/auth/session";
import { deleteOwnAccount } from "@/lib/account/delete";
import { normalizeEmail } from "@/lib/auth/normalize-email";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Milestone 12 §4.1: GDPR Art. 17. Requires the caller to re-type their own
 * email as `confirmEmail` — not a password, since an OAuth-only account has
 * none — before an irreversible delete proceeds. userId always comes from
 * the session, never a request body field, so this can only ever delete
 * the caller's OWN account.
 */
export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireVerifiedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (e instanceof EmailNotVerifiedError) {
      return Response.json({ error: "Verify your email first — check your inbox for the confirmation link." }, { status: 403 });
    }
    throw e;
  }

  const rate = checkRateLimit(`account:delete:${actor.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const confirmEmail = isRecord(body) && typeof body.confirmEmail === "string" ? body.confirmEmail : null;
  if (!confirmEmail || normalizeEmail(confirmEmail) !== normalizeEmail(actor.email)) {
    return Response.json({ error: "Type your account email exactly to confirm deletion." }, { status: 400 });
  }

  const result = await deleteOwnAccount(prisma, actor.id);
  switch (result.outcome) {
    case "deleted":
      return Response.json({ status: "deleted" });
    case "user_not_found":
      return Response.json({ error: "Account not found." }, { status: 404 });
    case "last_super_admin":
      return Response.json(
        { error: "You are the last remaining SUPER_ADMIN. Promote another account to SUPER_ADMIN, or demote yourself, before deleting this one." },
        { status: 409 },
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
