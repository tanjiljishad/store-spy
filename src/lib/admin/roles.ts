/**
 * The single source of truth for "who can do what" — roles are coarse,
 * permissions are fine-grained, and every route/service checks a
 * Permission, never a raw role string. Deliberately Prisma-free (same
 * convention as plan-limits.ts and monitoring/policy.ts): Role is
 * hand-mirrored from schema.prisma's enum rather than imported from
 * @prisma/client, so this stays unit-testable with no DB.
 */

export type Role =
  | "USER"
  | "ANALYST"
  | "CONTENT_ADMIN"
  | "SUPPORT_ADMIN"
  | "BILLING_ADMIN"
  | "OPS_ADMIN"
  | "SUPER_ADMIN";

export type Permission =
  | "user:read"
  | "user:plan:write"
  | "user:role:write"
  | "user:suspend"
  | "promo:read"
  | "promo:create"
  | "promo:assign"
  | "promo:revoke"
  | "store:tier:write"
  | "crawl:trigger"
  | "crawl:retry"
  | "metrics:read"
  | "audit:read";

/**
 * Deliberately only `SUPER_ADMIN` holds `user:role:write`, `promo:create`,
 * `promo:assign`, and `promo:revoke` — minting a 100%-off promo code is
 * equivalent to giving away the product, and changing anyone's role is how
 * every other permission in this table gets reassigned, so both stay with
 * one role rather than being spreadable across sub-admins.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: [],
  ANALYST: ["metrics:read"],
  CONTENT_ADMIN: ["metrics:read", "user:read"],
  SUPPORT_ADMIN: ["metrics:read", "user:read", "user:suspend", "crawl:retry"],
  BILLING_ADMIN: ["metrics:read", "user:read", "user:plan:write", "promo:read"],
  OPS_ADMIN: ["metrics:read", "user:read", "store:tier:write", "crawl:trigger", "crawl:retry"],
  SUPER_ADMIN: [
    "metrics:read",
    "user:read",
    "user:plan:write",
    "user:suspend",
    "crawl:retry",
    "store:tier:write",
    "crawl:trigger",
    "promo:read",
    "user:role:write",
    "promo:create",
    "promo:assign",
    "promo:revoke",
    "audit:read",
  ],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Invariant 2 (docs/milestone-11-security-rbac-promos.md section 2.4): an
 * actor can never grant a role whose permissions exceed their own. Written
 * generically — as a permission-set subset check, not a hardcoded "only
 * SUPER_ADMIN" comparison — so it stays correct if the matrix ever grows a
 * second role holding `user:role:write`. Today only SUPER_ADMIN holds that
 * permission at all, and SUPER_ADMIN's own set is the superset of every
 * other role's, so in practice this never blocks SUPER_ADMIN from granting
 * any non-SUPER_ADMIN role — SUPER_ADMIN itself is separately, unconditionally
 * blocked at the route layer regardless of this check (bootstrap-only, see
 * invariant 4), never through a permission comparison that could vary.
 */
export function canGrantRole(actorRole: Role, targetRole: Role): boolean {
  const targetPermissions = ROLE_PERMISSIONS[targetRole];
  const actorPermissions = new Set(ROLE_PERMISSIONS[actorRole]);
  return targetPermissions.every((p) => actorPermissions.has(p));
}
