import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireVerifiedUser, UnauthorizedError, EmailNotVerifiedError } from "@/lib/auth/session";
import { processCheckout } from "@/lib/billing/checkout";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { BillingPeriod } from "@/lib/billing/pricing";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 20, windowMs: 60 * 60_000 };
// Security review fix 4: a code-bearing checkout is the SAME promo
// brute-force surface as /api/billing/promo/validate — both return a
// distinguishable "invalid code" error (see the invalid_promo case below) —
// so it needs that route's tighter 10/hour budget, not this route's looser
// 20/hour plain-checkout one. Keyed separately from RATE_LIMIT above (its
// own bucket, `billing:checkout-promo:user:*`, distinct from both
// `billing:checkout:user:*` and /promo/validate's own `billing:promo-validate:user:*`)
// so a codeless checkout is never throttled by a code-guessing run against
// this same route, and vice versa — each per-user key only ever counts the
// requests that actually belong to it.
const PROMO_RATE_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const VALID_PLANS: PlanTier[] = ["BASIC", "BUSINESS"];
const VALID_PERIODS: BillingPeriod[] = ["MONTHLY", "ANNUAL"];

export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await requireVerifiedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "Sign in to check out." }, { status: 401 });
    }
    if (e instanceof EmailNotVerifiedError) {
      return Response.json({ error: "Verify your email first — check your inbox for the confirmation link." }, { status: 403 });
    }
    throw e;
  }

  const rate = checkRateLimit(`billing:checkout:user:${actor.id}`, RATE_LIMIT);
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

  if (code) {
    const promoRate = checkRateLimit(`billing:checkout-promo:user:${actor.id}`, PROMO_RATE_LIMIT);
    if (!promoRate.allowed) {
      return Response.json(
        { error: "Too many attempts. Try again later." },
        { status: 429, headers: { "retry-after": String(Math.ceil(promoRate.retryAfterMs / 1000)) } },
      );
    }
  }

  const result = await processCheckout(prisma, { userId: actor.id, plan: plan as PlanTier, period: period as BillingPeriod, code });

  switch (result.outcome) {
    case "completed_free":
      return Response.json({ status: "completed", plan: result.plan });
    case "pending":
      return Response.json({ status: "pending", checkoutId: result.checkoutId, finalCents: result.finalCents });
    case "invalid_promo":
      // Same collapsed, generic shape as /promo/validate — never leak why.
      return Response.json({ error: "This code isn't valid." }, { status: 400 });
    case "plan_not_purchasable":
      return Response.json({ error: "This plan cannot be purchased." }, { status: 400 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
