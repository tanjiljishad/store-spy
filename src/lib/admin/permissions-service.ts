import { Prisma, type PrismaClient } from "@prisma/client";
import { ALL_PERMISSIONS, SUPER_ADMIN_ONLY, effectivePermissions, permissionsFor, type Permission, type Role } from "./roles";
import { recordAdminAction } from "./audit";
import type { AdminActor } from "./guard";

/**
 * Milestone 12 §2.1/§2.2: per-employee permission grants layered on top of
 * the role matrix. Every write here pairs with exactly one audit row in the
 * same transaction (same convention as users-service.ts/promos-service.ts).
 */

export function isKnownPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export type GrantPermissionOutcome =
  | { outcome: "granted"; grantedAt: Date; expiresAt: Date | null }
  | { outcome: "already_granted" }
  | { outcome: "self_grant_forbidden" }
  | { outcome: "super_admin_only_permission" }
  | { outcome: "user_not_found" };

/**
 * Invariant, per this milestone's doc §2.2 and §2.4: rejects every
 * SUPER_ADMIN_ONLY permission unconditionally, regardless of who's asking
 * — including a SUPER_ADMIN — and rejects an actor granting to themselves.
 * Both checks run BEFORE touching the database, same "cheap invariants
 * first" ordering as updateUserRole()'s self-change/SUPER_ADMIN checks.
 *
 * Idempotent by design (invariant 7's own test): two concurrent grants of
 * the same (userId, permission) both return "granted"/"already_granted"
 * rather than one of them hard-failing — race-safe via
 * pg_advisory_xact_lock on a key derived from both, the same pattern
 * recordAnalysisUsage()/updateUserRole() use, with the DB's own partial
 * unique index (see schema.prisma's AdminPermissionGrant doc comment) as a
 * defense-in-depth backstop, not the primary mechanism.
 */
export async function grantPermission(
  prisma: PrismaClient,
  actor: AdminActor,
  targetUserId: string,
  permission: Permission,
  expiresAt: Date | null = null,
): Promise<GrantPermissionOutcome> {
  if (targetUserId === actor.id) {
    return { outcome: "self_grant_forbidden" };
  }
  if (SUPER_ADMIN_ONLY.includes(permission)) {
    return { outcome: "super_admin_only_permission" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('permission-grant:' || ${targetUserId} || ':' || ${permission})::bigint)`;

      const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true } });
      if (!target) return { outcome: "user_not_found" as const };

      const now = new Date();
      const existing = await tx.adminPermissionGrant.findFirst({
        where: { userId: targetUserId, permission, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { id: true },
      });
      if (existing) return { outcome: "already_granted" as const };

      const grant = await tx.adminPermissionGrant.create({
        data: { userId: targetUserId, permission, grantedByUserId: actor.id, expiresAt },
      });

      await recordAdminAction(tx, {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "permission.grant",
        targetType: "User",
        targetId: targetUserId,
        metadata: { permission, expiresAt: expiresAt?.toISOString() ?? null },
      });

      return { outcome: "granted" as const, grantedAt: grant.grantedAt, expiresAt: grant.expiresAt };
    });
  } catch (e) {
    // Belt-and-suspenders against the DB's own partial unique index (see
    // schema.prisma) — the advisory lock above already makes this
    // practically unreachable, but a P2002 here means "already granted,"
    // never a genuine failure worth surfacing as one.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { outcome: "already_granted" };
    }
    throw e;
  }
}

export type RevokePermissionOutcome = { outcome: "revoked" } | { outcome: "not_found" };

export async function revokePermission(
  prisma: PrismaClient,
  actor: AdminActor,
  targetUserId: string,
  permission: Permission,
): Promise<RevokePermissionOutcome> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const existing = await tx.adminPermissionGrant.findFirst({
      where: { userId: targetUserId, permission, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true },
    });
    if (!existing) return { outcome: "not_found" as const };

    await tx.adminPermissionGrant.update({ where: { id: existing.id }, data: { revokedAt: now } });
    await recordAdminAction(tx, {
      actorId: actor.id,
      actorEmail: actor.email,
      action: "permission.revoke",
      targetType: "User",
      targetId: targetUserId,
      metadata: { permission },
    });

    return { outcome: "revoked" as const };
  });
}

export interface GrantedPermissionItem {
  permission: Permission;
  grantedAt: string;
  expiresAt: string | null;
  grantedByUserId: string;
}
export interface EffectivePermissionsResult {
  role: Role;
  roleDerived: Permission[];
  granted: GrantedPermissionItem[];
  effective: Permission[];
}

/** GET /api/admin/users/[id]/permissions — role-derived vs granted, and their union, exactly as the doc's route bullet describes. */
export async function getEffectivePermissionsForUser(prisma: PrismaClient, userId: string): Promise<EffectivePermissionsResult | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) return null;

  const now = new Date();
  const activeGrants = await prisma.adminPermissionGrant.findMany({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { grantedAt: "asc" },
  });

  const grantedPermissions = activeGrants.map((g) => g.permission as Permission);
  const effective = effectivePermissions(user.role, grantedPermissions);

  return {
    role: user.role,
    roleDerived: permissionsFor(user.role).slice(),
    granted: activeGrants.map((g) => ({
      permission: g.permission as Permission,
      grantedAt: g.grantedAt.toISOString(),
      expiresAt: g.expiresAt?.toISOString() ?? null,
      grantedByUserId: g.grantedByUserId,
    })),
    effective: [...effective],
  };
}

/**
 * The live, grant-aware check requirePermission() (admin/guard.ts) uses for
 * a permission not already covered by the caller's role. Deliberately a
 * narrow existence check, not a full getEffectivePermissionsForUser() call
 * — the guard runs on every admin request and only needs a yes/no answer
 * for the ONE permission being checked, not the whole set.
 */
export async function hasActiveGrant(prisma: PrismaClient, userId: string, permission: Permission): Promise<boolean> {
  const now = new Date();
  const grant = await prisma.adminPermissionGrant.findFirst({
    where: { userId, permission, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * Security review fix 1: AdminLayout's gate ("has at least one effective
 * permission," not merely "role !== USER" — see admin/layout.tsx) needs
 * existence of ANY active grant for a USER-role account, not one specific
 * permission. Same shape as hasActiveGrant() above with the permission
 * filter dropped. Every non-USER role already has a non-empty role-derived
 * permission set (see roles.ts's ROLE_PERMISSIONS), so callers only need
 * this for the one role that doesn't — checking that cheaply first, the
 * same "role check before DB fallback" ordering requirePermission() itself
 * uses, avoids a query for the common case.
 */
export async function hasAnyActiveGrant(prisma: PrismaClient, userId: string): Promise<boolean> {
  const now = new Date();
  const grant = await prisma.adminPermissionGrant.findFirst({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true },
  });
  return grant !== null;
}

/** Run from the worker tick, next to the other sweeps — see AdminPermissionGrant's own schema.prisma doc comment for why this is bookkeeping, not the enforcement mechanism (the live queries above already re-check expiresAt directly). */
export async function expireDuePermissionGrants(prisma: PrismaClient, now: Date = new Date()): Promise<{ expiredCount: number }> {
  const result = await prisma.adminPermissionGrant.updateMany({
    where: { revokedAt: null, expiresAt: { lte: now } },
    data: { revokedAt: now },
  });
  return { expiredCount: result.count };
}
