import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { createPromo, listPromos } from "@/lib/admin/promos-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { PlanTier } from "@/lib/entitlements/plan-limits";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const VALID_PLANS: PlanTier[] = ["FREE", "BASIC", "BUSINESS"];

export async function GET(req: NextRequest) {
  return withAdminRoute("promo:read", async (actor) => {
    const rate = checkRateLimit(`admin:promos:read:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");
    const page = await listPromos(prisma, { cursor: cursor ?? undefined, limit: limitParam ? Number(limitParam) : undefined });
    return Response.json(page);
  });
}

export async function POST(req: NextRequest) {
  return withAdminRoute("promo:create", async (actor) => {
    const rate = checkRateLimit(`admin:promos:create:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const discountType = body.discountType === "PERCENT" || body.discountType === "FIXED" ? body.discountType : null;
    const discountValue = typeof body.discountValue === "number" ? body.discountValue : null;
    const validFromRaw = typeof body.validFrom === "string" ? new Date(body.validFrom) : null;
    if (!discountType || discountValue === null || !validFromRaw || Number.isNaN(validFromRaw.getTime())) {
      return Response.json({ error: "discountType, discountValue, and validFrom are required" }, { status: 400 });
    }

    const appliesToPlan =
      typeof body.appliesToPlan === "string" && VALID_PLANS.includes(body.appliesToPlan as PlanTier)
        ? (body.appliesToPlan as PlanTier)
        : null;
    const maxRedemptions = typeof body.maxRedemptions === "number" ? body.maxRedemptions : null;
    const perUserLimit = typeof body.perUserLimit === "number" ? body.perUserLimit : undefined;
    const validUntil = typeof body.validUntil === "string" ? new Date(body.validUntil) : null;
    const assignedToUserId = typeof body.assignedToUserId === "string" ? body.assignedToUserId : null;
    const vanityCode = typeof body.vanityCode === "string" ? body.vanityCode : null;
    const durationDays = typeof body.durationDays === "number" ? body.durationDays : null;

    if (validUntil && Number.isNaN(validUntil.getTime())) {
      return Response.json({ error: "Invalid validUntil" }, { status: 400 });
    }

    const result = await createPromo(prisma, actor, {
      vanityCode,
      discountType,
      discountValue,
      appliesToPlan,
      maxRedemptions,
      perUserLimit,
      validFrom: validFromRaw,
      validUntil,
      assignedToUserId,
      durationDays,
    });

    switch (result.outcome) {
      case "created":
        // The full code is returned exactly once — never retrievable again
        // after this response (listPromos shows it too, per §3.5, since an
        // admin who can read promos can already use them — but this is the
        // one guaranteed moment the caller who just minted it sees it).
        return Response.json({ id: result.id, code: result.code }, { status: 201 });
      case "invalid_discount_value":
        return Response.json({ error: "Invalid discount value for the given type." }, { status: 400 });
      case "invalid_date_range":
        return Response.json({ error: "validUntil must be after validFrom." }, { status: 400 });
      case "invalid_vanity_code":
        return Response.json({ error: "Vanity code must be 4-32 uppercase letters/digits." }, { status: 400 });
      case "code_collision":
        return Response.json({ error: "That code already exists." }, { status: 409 });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
