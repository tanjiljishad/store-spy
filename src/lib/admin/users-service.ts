import { Prisma, type PrismaClient } from "@prisma/client";
import type { PlanTier } from "../entitlements/plan-limits";
import { canGrantRole, type Role } from "./roles";
import { recordAdminAction } from "./audit";
import type { AdminActor } from "./guard";
import { clearTrialCeiling } from "../billing/subscription-sweep";
import { resolveTrialEnd, syncControlPlanePlan } from "../control-plane/provision";

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

/** B2 2·B commit 3a: active/trialing so a lapsed row can't answer "what tier". */
const LIVE_SUB_STATUS: Prisma.CpSubscriptionWhereInput["status"] = { in: ["ACTIVE", "TRIALING"] };

/** The one CpUser row shape searchUsers() / getUserDetail() / exportUsers() all read: id/email/createdAt plus the joined admin role and the purchased tier. */
const USER_ROW_SELECT = {
  id: true,
  email: true,
  createdAt: true,
  adminRole: { select: { role: true } },
  account: {
    select: {
      subscriptions: { where: { status: LIVE_SUB_STATUS }, select: { planSlug: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  },
} satisfies Prisma.CpUserSelect;

type UserRow = Prisma.CpUserGetPayload<{ select: typeof USER_ROW_SELECT }>;

function toItem(u: UserRow): UserSearchItem {
  return {
    id: u.id,
    email: u.email,
    plan: (u.account.subscriptions[0]?.planSlug as PlanTier | undefined) ?? "FREE",
    role: u.adminRole?.role ?? "USER",
    createdAt: u.createdAt.toISOString(),
  };
}

/**
 * Shared by searchUsers() (paginated) and analytics/user-export.ts's
 * exportUsers() (unpaginated) — the one place a plan/role/email filter turns
 * into a where clause. B2 2·B commit 3a: the query now originates from
 * control_plane.users. `plan` is a BILLING filter — it matches on the
 * account's live subscription `planSlug` (what they bought), never on an
 * entitlement quota value; `role` matches the store_spy.UserAdminRole join
 * (absence = USER).
 */
export function buildUserSearchWhere(opts: Pick<UserSearchFilters, "emailQuery" | "plan" | "role">): Prisma.CpUserWhereInput {
  const where: Prisma.CpUserWhereInput = {};
  if (opts.emailQuery) where.email = { contains: opts.emailQuery, mode: "insensitive" };
  if (opts.plan) where.account = { is: { subscriptions: { some: { planSlug: opts.plan, status: LIVE_SUB_STATUS } } } };
  if (opts.role) where.adminRole = opts.role === "USER" ? { is: null } : { is: { role: opts.role } };
  return where;
}

export async function searchUsers(prisma: PrismaClient, opts: UserSearchFilters = {}): Promise<UserSearchPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const direction = opts.sort === "createdAt_asc" ? "asc" : "desc";

  const rows = await prisma.cpUser.findMany({
    where: buildUserSearchWhere(opts),
    orderBy: [{ createdAt: direction }, { id: direction }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: USER_ROW_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    items: page.map(toItem),
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
  const user = await prisma.cpUser.findUnique({ where: { id: userId }, select: USER_ROW_SELECT });
  if (!user) return null;

  const [analysesUsed, activeWatchCount] = await Promise.all([
    prisma.analysisUsage.count({ where: { userId } }),
    prisma.watchlist.count({ where: { userId, monitoringStatus: "ACTIVE" } }),
  ]);

  return { ...toItem(user), analysesUsed, activeWatchCount };
}

/**
 * The actual plan-update logic, shared verbatim between
 * scripts/set-user-plan.ts and PATCH /api/admin/users/[id]/plan — one
 * implementation, not two that could drift. A route calls it inside its own
 * `prisma.$transaction()` (passing `tx`) to pair the write with an audit row;
 * the script calls it with the plain top-level client. B2 2·B commit 3b: the
 * control plane is the sole store of plan — no `store_spy.User.plan` write.
 */
export async function setUserPlan(
  db: Pick<PrismaClient, "watchlist" | "cpAccount" | "cpUser" | "cpSubscription" | "cpEntitlement">,
  userId: string,
  plan: PlanTier,
): Promise<{ id: string; email: string; plan: PlanTier } | null> {
  const cpUser = await db.cpUser.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!cpUser) return null;

  // Milestone 12 §1.4: an admin moving a user off FREE must lift any
  // trial-ceiling expiry the same way a real checkout does (see
  // billing/checkout.ts) — this is the shared implementation both call, so an
  // admin-granted plan change isn't a second path that could drift.
  if (plan !== "FREE") await clearTrialCeiling(db, userId);
  // Admin-set plans are perpetual (paidPeriodEnd null); on a downgrade to FREE
  // the trial window is whatever it already was (resolveTrialEnd), not reset.
  const trialEndsAt = plan === "FREE" ? await resolveTrialEnd(db, userId) : null;
  await syncControlPlanePlan(db, { userId, plan, trialEndsAt, paidPeriodEnd: null });
  return { id: cpUser.id, email: cpUser.email, plan };
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
    // B2 2·B commit 3a: existence from control_plane.users; the prior tier for
    // the audit row from the account's live subscription planSlug.
    const exists = await tx.cpUser.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!exists) return { outcome: "user_not_found" };
    const beforeSub = await tx.cpSubscription.findFirst({
      where: { accountId: `acct_${targetUserId}`, status: LIVE_SUB_STATUS },
      orderBy: { createdAt: "desc" },
      select: { planSlug: true },
    });
    const fromPlan = (beforeSub?.planSlug as PlanTier | undefined) ?? "FREE";

    const updated = await setUserPlan(tx, targetUserId, plan);
    if (!updated) return { outcome: "user_not_found" };

    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "user.plan.update",
      targetType: "User",
      targetId: targetUserId,
      metadata: { fromPlan, toPlan: plan },
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
    // B2 2·B commit 3a: existence from control_plane.users; current role from
    // store_spy.UserAdminRole (absence = USER).
    const exists = await tx.cpUser.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!exists) return { outcome: "user_not_found" };
    const currentRole: Role = (await tx.userAdminRole.findUnique({ where: { userId: targetUserId }, select: { role: true } }))?.role ?? "USER";

    if (currentRole === "SUPER_ADMIN") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin:super-admin-count')::bigint)`;
      const superAdminCount = await tx.userAdminRole.count({ where: { role: "SUPER_ADMIN" } });
      if (superAdminCount <= 1) {
        return { outcome: "last_super_admin" };
      }
    }

    // Role lives only in store_spy.UserAdminRole now (absence = USER).
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
      metadata: { fromRole: currentRole, toRole: newRole },
    });

    return { outcome: "updated", role: newRole };
  });
}

export type RevokeSessionsOutcome = { outcome: "revoked" } | { outcome: "user_not_found" };

/** Sets control_plane.users.sessionsValidAfter = now() — see jwt-session-refresh.ts for how the jwt callback enforces it. */
export async function revokeUserSessions(
  prisma: PrismaClient,
  actor: AdminActor,
  targetUserId: string,
): Promise<RevokeSessionsOutcome> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.cpUser.findUnique({ where: { id: targetUserId }, select: { id: true } });
    if (!target) return { outcome: "user_not_found" };

    const now = new Date();
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
