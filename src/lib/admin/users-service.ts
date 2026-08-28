import { Prisma, type PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";
import { canGrantRole, type Role } from "./roles";
import { recordAdminAction } from "./audit";
import type { AdminActor } from "./guard";
import { clearTrialCeiling } from "../billing/subscription-sweep";
import { syncControlPlanePlan } from "../control-plane/provision";

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

export type UserSortOrder = "createdAt_desc" | "createdAt_asc";

export interface UserSearchFilters {
  emailQuery?: string;
  /** Milestone 12 Section 3.3: "GET /api/admin/users gains search, plan/role filters, and sort." */
  plan?: PlanTier;
  role?: Role;
  sort?: UserSortOrder;
  cursor?: string | null;
  limit?: number;
}

/** Shared by searchUsers() (paginated) and analytics/user-export.ts's exportUsers() (unpaginated) — the one place a plan/role/email filter turns into a Prisma where clause. */
export function buildUserSearchWhere(opts: Pick<UserSearchFilters, "emailQuery" | "plan" | "role">): Prisma.UserWhereInput {
  return {
    ...(opts.emailQuery ? { email: { contains: opts.emailQuery, mode: "insensitive" } } : {}),
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.role ? { role: opts.role } : {}),
  };
}

export async function searchUsers(prisma: PrismaClient, opts: UserSearchFilters = {}): Promise<UserSearchPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const direction = opts.sort === "createdAt_asc" ? "asc" : "desc";

  const rows = await prisma.user.findMany({
    where: buildUserSearchWhere(opts),
    orderBy: [{ createdAt: direction }, { id: direction }],
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
  db: Pick<PrismaClient, "user" | "watchlist" | "cpAccount" | "cpUser" | "cpSubscription" | "cpEntitlement">,
  userId: string,
  plan: PlanTier,
): Promise<{ id: string; email: string; plan: PlanTier } | null> {
  try {
    // TRANSITIONAL (B2 step 2·B): the User.plan write. 2·A keeps it alongside
    // the control-plane write below; 2·B drops it.
    const updated = await db.user.update({
      where: { id: userId },
      data: { plan },
      select: { id: true, email: true, plan: true, freeTrialEndsAt: true },
    });
    // Milestone 12 §1.4: an admin moving a user off FREE must lift any
    // trial-ceiling expiry the same way a real checkout does (see
    // billing/checkout.ts) — this is the shared implementation both call,
    // so an admin-granted plan change isn't a second path that could drift.
    if (plan !== "FREE") await clearTrialCeiling(db, userId);
    // B2 step 2·A dual-write. Admin-set plans are perpetual (paidPeriodEnd
    // null), matching the step-1 backfill for admin-set BASIC users.
    await syncControlPlanePlan(db, { userId, plan, trialEndsAt: updated.freeTrialEndsAt, paidPeriodEnd: null });
    return { id: updated.id, email: updated.email, plan: updated.plan };
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

    // TRANSITIONAL (B2 step 2·B): the store_spy.User.role write. 2·A keeps it
    // next to the store_spy.UserAdminRole write; 2·B repoints role readers
    // (jwt-session-refresh, account/delete) to UserAdminRole and drops this.
    await tx.user.update({ where: { id: targetUserId }, data: { role: newRole } });
    if (newRole === "USER") {
      await tx.userAdminRole.deleteMany({ where: { userId: targetUserId } });
    } else {
      await tx.userAdminRole.upsert({
        where: { userId: targetUserId },
        create: { userId: targetUserId, role: newRole },
        update: { role: newRole },
      });
    }
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
    // TRANSITIONAL (B2 step 2·B): the store_spy.User write. 2·A dual-writes so
    // the revocation floor is already in control_plane.users when
    // jwt-session-refresh starts reading it there.
    await tx.user.update({ where: { id: targetUserId }, data: { sessionsValidAfter: now } });
    await tx.cpUser.updateMany({ where: { id: targetUserId }, data: { sessionsValidAfter: now } });
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
