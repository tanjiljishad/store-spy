import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { evaluatePromo } from "@/lib/billing/promo";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { BillingPeriod } from "@/lib/billing/pricing";

export const runtime = "nodejs";

/** This is the brute-force surface for promo codes — treat it like a login. */
const RATE_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const VALID_PLANS: PlanTier[] = ["BASIC", "BUSINESS"];
const VALID_PERIODS: BillingPeriod[] = ["MONTHLY", "ANNUAL"];

export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "Sign in to validate a promo code." }, { status: 401 });
    }
    throw e;
  }

  const rate = checkRateLimit(`billing:promo-validate:user:${actor.id}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const plan = isRecord(body) && typeof body.plan === "string" ? body.plan : null;
  const period = isRecord(body) && typeof body.period === "string" ? body.period : null;
  const code = isRecord(body) && typeof body.code === "string" ? body.code : null;

  if (!plan || !VALID_PLANS.includes(plan as PlanTier)) {
    return Response.json({ error: "Invalid plan" }, { status: 400 });
  }
  if (!period || !VALID_PERIODS.includes(period as BillingPeriod)) {
    return Response.json({ error: "Invalid period" }, { status: 400 });
  }
  if (!code) {
    return Response.json({ error: "Missing code" }, { status: 400 });
  }

  const evaluation = await evaluatePromo(prisma, { code, userId: actor.id, plan: plan as PlanTier, period: period as BillingPeriod });

  // Every rejection reason collapses to the same generic response — never
  // surface `reason` to the browser verbatim, it leaks code existence (and
  // specifically must be indistinguishable from "not_found" for an
  // assigned-to-someone-else code — see promo.ts's own doc comment).
  if (!evaluation.ok) {
    return Response.json({ ok: false, error: "This code isn't valid." }, { status: 200 });
  }

  return Response.json({
    ok: true,
    listPriceCents: evaluation.listPriceCents,
    discountCents: evaluation.discountCents,
    finalCents: evaluation.finalCents,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
