import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardSummary } from "@/lib/dashboard/summary";
import { prisma } from "@/lib/db/prisma";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

export async function GET(req: NextRequest) {
  const rate = checkRateLimit(`dashboard:${getClientIp(req.headers)}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }

  const summary = await getDashboardSummary(prisma, user.id);
  return Response.json(summary);
}
