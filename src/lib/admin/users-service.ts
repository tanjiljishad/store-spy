import { Prisma, type PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";
import { canGrantRole, type Role } from "./roles";
import { recordAdminAction } from "./audit";
import type { AdminActor } from "./guard";

/**
 * The admin-facing user operations — search, detail, plan/role writes,
 * session revocation. Every WRITE here is either called from inside the
 * caller's own transaction (setUserPlan, accepting `Pick<PrismaClient,
 * "user">` so a `tx` and the top-level `prisma` client are interchangeable)
 * or owns its own transaction that includes the audit-log write (see
 * audit.ts's own doc comment on why that pairing is mandatory).
 */

export interface UserSearchItem {
  id: string;
  email: string;
  plan: PlanTier;
  role: Role;
  createdAt: string;
}
export interface UserSearchPage {
  items: UserSearchItem[];
  nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function searchUsers(
  prisma: PrismaClient,
  opts: { emailQuery?: string; cursor?: string | null; limit?: number } = {},
): Promise<UserSearchPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

  const rows = await prisma.user.findMany({
    where: opts.emailQuery ? { email: { contains: opts.emailQuery, mode: "insensitive" } } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, email: true, plan: true, role: true, createdAt: true },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map((u) => ({ id: u.id, email: u.email, plan: u.plan, role: u.role, createdAt: u.createdAt.toISOString() })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export interface UserDetail {
  id: string;
  email: string;
  plan: PlanTier;
  role: Role;
  createdAt: string;
  analysesUsed: number;
  activeWatchCount: number;
}

export async function getUserDetail(prisma: PrismaClient, userId: string): Promise<UserDetail | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, plan: true, role: true, createdAt: true },
  });
  if (!user) return null;

  const [analysesUsed, activeWatchCount] = await Promise.all([
    prisma.analysisUsage.count({ where: { userId } }),
    prisma.watchlist.count({ where: { userId, monitoringStatus: "ACTIVE" } }),
  ]);

  return { ...user, createdAt: user.createdAt.toISOString(), analysesUsed, activeWatchCount };
}

/**
 * The actual plan-update logic, shared verbatim between
 * scripts/set-user-plan.ts and PATCH /api/admin/users/[id]/plan — one
 * implementation, not two that could drift. Takes `Pick<PrismaClient,
 * "user">` specifically so a route can call it inside its own
 * `prisma.$transaction()` (passing `tx`) to pair the write with an audit
 * row, while the script calls it with the plain top-level client.
 */
export async function setUserPlan(
  db: Pick<PrismaClient, "user">,
  userId: string,
  plan: PlanTier,
): Promise<{ id: string; email: string; plan: PlanTier } | null> {
  try {
    return await db.user.update({ where: { id: userId }, data: { plan }, select: { id: true, email: true, plan: true } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return null; // not found
    throw e;
  }
}

export type UpdateUserPlanOutcome = { outcome: "updated"; plan: PlanTier } | { outcome: "user_not_found" };

/** Route-facing wrapper: pairs setUserPlan() with its required audit row in one transaction. scripts/set-user-plan.ts calls setUserPlan() directly instead — it has no admin actor to attribute the change to. */
export async function updateUserPlanWithAudit(
  prisma: PrismaClient,
  actor: AdminActor,
  targetUserId: string,
  plan: PlanTier,
): Promise<UpdateUserPlanOutcome> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: targetUserId }, select: { plan: true } });
    if (!before) return { outcome: "user_not_found" };

    const updated = await setUserPlan(tx, targetUserId, plan);
    if (!updated) return { outcome: "user_not_found" };

    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "user.plan.update",
      targetType: "User",
      targetId: targetUserId,
      metadata: { fromPlan: before.plan, toPlan: plan },
    });

    return { outcome: "updated", plan };
  });
}

export type UpdateUserRoleOutcome =
  | { outcome: "updated"; role: Role }
  | { outcome: "self_change_forbidden" }
  | { outcome: "role_not_held_by_actor" }
  | { outcome: "super_admin_not_grantable" }
  | { outcome: "last_super_admin" }
  | { outcome: "user_not_found" };

/**
 * Enforces all four role-write invariants from this milestone's doc,
 * section 2.4:
 *   1. self-change forbidden
 *   2. actor cannot grant a role exceeding their own permissions (generic
 *      subset check — canGrantRole(), not a hardcoded role name)
 *   4. SUPER_ADMIN is bootstrap-only, never grantable here
 *   3. the last remaining SUPER_ADMIN cannot be demoted — race-safe via
 *      pg_advisory_xact_lock on a FIXED key, then a COUNT, exactly the
 *      pattern recordAnalysisUsage.ts uses: a plain check-then-write here
 *      would let two concurrent demotions of the last two SUPER_ADMINs
 *      both read "count = 2" before either commits and both proceed,
 *      leaving zero.
 * 1, 2, and 4 are cheap and need no transaction — checked first, before
 * ever touching the database.
 */
export async function updateUserRole(
  prisma: PrismaClient,
  actor: AdminActor,
  targetUserId: string,
  newRole: Role,
): Promise<UpdateUserRoleOutcome> {
  if (targetUserId === actor.id) {
    return { outcome: "self_change_forbidden" };
  }
  if (newRole === "SUPER_ADMIN") {
    return { outcome: "super_admin_not_grantable" };
  }
  if (!canGrantRole(actor.role, newRole)) {
    return { outcome: "role_not_held_by_actor" };
  }

  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { role: true } });
    if (!target) return { outcome: "user_not_found" };

    if (target.role === "SUPER_ADMIN") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin:super-admin-count')::bigint)`;
      const superAdminCount = await tx.user.count({ where: { role: "SUPER_ADMIN" } });
      if (superAdminCount <= 1) {
        return { outcome: "last_super_admin" };
      }
    }

    await tx.user.update({ where: { id: targetUserId }, data: { role: newRole } });
    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "user.role.update",
      targetType: "User",
      targetId: targetUserId,
      metadata: { fromRole: target.role, toRole: newRole },
    });

    return { outcome: "updated", role: newRole };
  });
}

export type RevokeSessionsOutcome = { outcome: "revoked" } | { outcome: "user_not_found" };

/** Sets User.sessionsValidAfter = now() — see jwt-plan-refresh.ts for how the jwt callback enforces it. */
export async function revokeUserSessions(
  prisma: PrismaClient,
  actor: AdminActor,
  targetUserId: string,
): Promise<RevokeSessionsOutcome> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) return { outcome: "user_not_found" };

    const now = new Date();
    await tx.user.update({ where: { id: targetUserId }, data: { sessionsValidAfter: now } });
    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "user.sessions.revoke",
      targetType: "User",
      targetId: targetUserId,
      metadata: { revokedAt: now.toISOString() },
    });

    return { outcome: "revoked" };
  });
}
