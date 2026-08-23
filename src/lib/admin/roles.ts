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
  | "MARKETING_ADMIN"
  | "MANAGER"
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
  | "audit:read"
  // Milestone 12 §2.3 — new this milestone.
  | "campaign:read"
  | "campaign:write"
  | "integration:read"
  | "integration:credentials:write"
  | "permission:grant"
  | "analytics:read"
  | "export:users"
  | "billing:provider:write"
  | "billing:refund"
  | "billing:payout:read";

export const ALL_PERMISSIONS: readonly Permission[] = [
  "user:read",
  "user:plan:write",
  "user:role:write",
  "user:suspend",
  "promo:read",
  "promo:create",
  "promo:assign",
  "promo:revoke",
  "store:tier:write",
  "crawl:trigger",
  "crawl:retry",
  "metrics:read",
  "audit:read",
  "campaign:read",
  "campaign:write",
  "integration:read",
  "integration:credentials:write",
  "permission:grant",
  "analytics:read",
  "export:users",
  "billing:provider:write",
  "billing:refund",
  "billing:payout:read",
];

/**
 * Milestone 12 §2.2 — "only I touch money," enforced in code rather than by
 * convention. grantPermission() (permissions-service.ts) rejects every
 * member of this list unconditionally, regardless of who's asking —
 * including a SUPER_ADMIN. These are reachable *only* by holding the
 * SUPER_ADMIN role itself (see SUPER_ADMIN's own baseline set below, which
 * is the only place any of them appear), which is exactly what makes "can a
 * non-super-admin ever touch payments?" answerable by reading one array.
 */
export const SUPER_ADMIN_ONLY: readonly Permission[] = [
  "user:role:write",
  "promo:create",
  "promo:assign",
  "promo:revoke",
  "billing:provider:write", // payment provider keys and configuration
  "billing:refund",
  "billing:payout:read",
  "integration:credentials:write",
  "permission:grant",
];

/**
 * Deliberately only `SUPER_ADMIN` holds `user:role:write`, `promo:create`,
 * `promo:assign`, and `promo:revoke` — minting a 100%-off promo code is
 * equivalent to giving away the product, and changing anyone's role is how
 * every other permission in this table gets reassigned, so both stay with
 * one role rather than being spreadable across sub-admins. The same
 * reasoning extends this milestone to every member of SUPER_ADMIN_ONLY
 * above — SUPER_ADMIN's baseline set below is the ONLY role matrix entry
 * that contains any of them, which is what makes those permissions
 * unreachable through a grant at all.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: [],
  ANALYST: ["metrics:read"],
  CONTENT_ADMIN: ["metrics:read", "user:read"],
  SUPPORT_ADMIN: ["metrics:read", "user:read", "user:suspend", "crawl:retry"],
  BILLING_ADMIN: ["metrics:read", "user:read", "user:plan:write", "promo:read"],
  OPS_ADMIN: ["metrics:read", "user:read", "store:tier:write", "crawl:trigger", "crawl:retry"],
  // Milestone 12 §2.3: the marketing/ops seat — narrow, campaign-focused.
  MARKETING_ADMIN: ["metrics:read", "user:read", "campaign:read", "campaign:write"],
  // Milestone 12 §2.3: "the union of SUPPORT_ADMIN and OPS_ADMIN, plus
  // audit:read" — the doc's own words, literally. The 2-3 manager seats.
  MANAGER: ["metrics:read", "user:read", "user:suspend", "crawl:retry", "store:tier:write", "crawl:trigger", "audit:read"],
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
    "campaign:read",
    "campaign:write",
    "integration:read",
    "integration:credentials:write",
    "permission:grant",
    "analytics:read",
    "export:users",
    "billing:provider:write",
    "billing:refund",
    "billing:payout:read",
  ],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Milestone 12 §2.1: effective set = role-derived ∪ grants. Additive only
 * by construction — there is no code path here that can remove a
 * role-derived permission; a grant can only ever add to the Set a role's
 * own permissions already seeded it with. Narrowing access is exclusively
 * done by changing the role (updateUserRole(), users-service.ts).
 */
export function effectivePermissions(role: Role, grants: Permission[]): Set<Permission> {
  return new Set([...ROLE_PERMISSIONS[role], ...grants]);
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
