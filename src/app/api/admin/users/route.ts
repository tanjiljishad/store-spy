import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { withAdminRoute } from "@/lib/admin/guard";
import { searchUsers, type UserSortOrder } from "@/lib/admin/users-service";
import { checkRateLimit } from "@/lib/security/rate-limit";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { Role } from "@/lib/admin/roles";

export const runtime = "nodejs";

const RATE_LIMIT = { limit: 60, windowMs: 60_000 }; // read-only, more generous than the write routes
const VALID_PLANS: PlanTier[] = ["FREE", "BASIC", "BUSINESS"];
const VALID_ROLES: Role[] = [
  "USER",
  "ANALYST",
  "CONTENT_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
  "OPS_ADMIN",
  "MARKETING_ADMIN",
  "MANAGER",
  "SUPER_ADMIN",
];
const VALID_SORTS: UserSortOrder[] = ["createdAt_desc", "createdAt_asc"];

/** Milestone 12 §3.3: "GET /api/admin/users gains search, plan/role filters, and sort." */
export async function GET(req: NextRequest) {
  return withAdminRoute("user:read", async (actor) => {
    const rate = checkRateLimit(`admin:users:user:${actor.id}`, RATE_LIMIT);
    if (!rate.allowed) {
      return Response.json({ error: "Too many requests. Try again shortly." }, { status: 429 });
    }

    const url = new URL(req.url);
    const emailQuery = url.searchParams.get("email") ?? undefined;
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");

    const planParam = url.searchParams.get("plan");
    if (planParam !== null && !VALID_PLANS.includes(planParam as PlanTier)) {
      return Response.json({ error: "Invalid plan filter" }, { status: 400 });
    }
    const roleParam = url.searchParams.get("role");
    if (roleParam !== null && !VALID_ROLES.includes(roleParam as Role)) {
      return Response.json({ error: "Invalid role filter" }, { status: 400 });
    }
    const sortParam = url.searchParams.get("sort");
    if (sortParam !== null && !VALID_SORTS.includes(sortParam as UserSortOrder)) {
      return Response.json({ error: "Invalid sort" }, { status: 400 });
    }

    const page = await searchUsers(prisma, {
      emailQuery,
      plan: (planParam as PlanTier | null) ?? undefined,
      role: (roleParam as Role | null) ?? undefined,
      sort: (sortParam as UserSortOrder | null) ?? undefined,
      cursor: cursor ?? undefined,
      limit: limitParam ? Number(limitParam) : undefined,
    });

    return Response.json(page);
  });
}
