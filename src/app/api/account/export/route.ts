import { prisma } from "@/lib/db/prisma";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { exportOwnAccountData } from "@/lib/account/export";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/** Milestone 12 §4.1: GDPR Art. 15 — the signed-in user's own data, never anyone else's (userId comes from the session, never a request param). */
export async function GET() {
  let actor;
  try {
    actor = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const rate = checkRateLimit(`account:export:${actor.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const data = await exportOwnAccountData(prisma, actor.id);
  if (!data) {
    // The session's own user row is gone — should be unreachable (a
    // deleted account's JWT collapses to anonymous within one refresh, see
    // jwt-plan-refresh.ts), but never surface a confusing 500 if it somehow is.
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="bellwether-account-data-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
