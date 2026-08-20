import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { updateUserPlanWithAudit } from "@/lib/admin/users-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { PlanTier } from "@/lib/entitlements/plan-limits";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const VALID_PLANS: PlanTier[] = ["FREE", "BASIC", "BUSINESS"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withAdminRoute("user:plan:write", async (actor) => {
    const rate = checkRateLimit(`admin:plan:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const { id: targetUserId } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const plan = isRecord(body) && typeof body.plan === "string" ? body.plan : null;
    if (!plan || !VALID_PLANS.includes(plan as PlanTier)) {
      return Response.json({ error: "Invalid plan" }, { status: 400 });
    }

    const result = await updateUserPlanWithAudit(prisma, actor, targetUserId, plan as PlanTier);
    if (result.outcome === "user_not_found") {
      return Response.json({ error: "User not found." }, { status: 404 });
    }
    return Response.json({ id: targetUserId, plan: result.plan });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
