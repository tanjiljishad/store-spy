import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  SUPER_ADMIN_ONLY,
  canGrantRole,
  effectivePermissions,
  hasPermission,
  permissionsFor,
  type Permission,
  type Role,
} from "../roles";

const ROLES: Role[] = [
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
const PERMISSIONS: Permission[] = ALL_PERMISSIONS.slice();

/**
 * The literal expected table from docs/milestone-11-security-rbac-promos.md
 * section 2.1, extended by docs/milestone-12-freemium-admin-marketing.md
 * section 2.3 — every role/permission pair is asserted individually so an
 * accidental grant widening (or narrowing) fails loudly, not just "some
 * test somewhere broke."
 */
const EXPECTED: Record<Role, Permission[]> = {
  USER: [],
  ANALYST: ["metrics:read"],
  CONTENT_ADMIN: ["metrics:read", "user:read"],
  SUPPORT_ADMIN: ["metrics:read", "user:read", "user:suspend", "crawl:retry"],
  BILLING_ADMIN: ["metrics:read", "user:read", "user:plan:write", "promo:read"],
  OPS_ADMIN: ["metrics:read", "user:read", "store:tier:write", "crawl:trigger", "crawl:retry"],
  MARKETING_ADMIN: ["metrics:read", "user:read", "campaign:read", "campaign:write"],
  // "The union of SUPPORT_ADMIN and OPS_ADMIN, plus audit:read" — the doc's own words.
  MANAGER: ["metrics:read", "user:read", "user:suspend", "crawl:retry", "store:tier:write", "crawl:trigger", "audit:read"],
  SUPER_ADMIN: PERMISSIONS.slice(),
};

describe("role -> permission matrix", () => {
  it.each(ROLES)("%s grants exactly the expected permission set", (role) => {
    expect(new Set(permissionsFor(role))).toEqual(new Set(EXPECTED[role]));
  });

  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const expected = EXPECTED[role].includes(permission);
      it(`hasPermission("${role}", "${permission}") === ${expected}`, () => {
        expect(hasPermission(role, permission)).toBe(expected);
      });
    }
  }

  it("only SUPER_ADMIN can write roles", () => {
    for (const role of ROLES) {
      expect(hasPermission(role, "user:role:write")).toBe(role === "SUPER_ADMIN");
    }
  });

  it("only SUPER_ADMIN can mint, assign, or revoke promo codes", () => {
    for (const role of ROLES) {
      const expected = role === "SUPER_ADMIN";
      expect(hasPermission(role, "promo:create")).toBe(expected);
      expect(hasPermission(role, "promo:assign")).toBe(expected);
      expect(hasPermission(role, "promo:revoke")).toBe(expected);
    }
  });

  it("BILLING_ADMIN can read promos but not mint them", () => {
    expect(hasPermission("BILLING_ADMIN", "promo:read")).toBe(true);
    expect(hasPermission("BILLING_ADMIN", "promo:create")).toBe(false);
  });

  it("USER has no permissions at all", () => {
    expect(permissionsFor("USER")).toEqual([]);
  });

  it("MANAGER is exactly SUPPORT_ADMIN ∪ OPS_ADMIN ∪ {audit:read} — computed from the matrix, not hand-copied", () => {
    const union = new Set([...permissionsFor("SUPPORT_ADMIN"), ...permissionsFor("OPS_ADMIN"), "audit:read" as const]);
    expect(new Set(permissionsFor("MANAGER"))).toEqual(union);
  });
});

describe("canGrantRole — invariant 2, permission-set subset check", () => {
  it("SUPER_ADMIN can grant every role, since its own set is the superset of all of them", () => {
    for (const role of ROLES) {
      expect(canGrantRole("SUPER_ADMIN", role)).toBe(true);
    }
  });

  it("a role can always grant itself (subset of itself, trivially)", () => {
    for (const role of ROLES) {
      expect(canGrantRole(role, role)).toBe(true);
    }
  });

  it("neither BILLING_ADMIN nor OPS_ADMIN can grant the other — real, concrete non-subset pair from the matrix", () => {
    // BILLING_ADMIN has user:plan:write and promo:read, which OPS_ADMIN
    // lacks; OPS_ADMIN has store:tier:write and crawl:trigger, which
    // BILLING_ADMIN lacks. Neither set contains the other.
    expect(canGrantRole("BILLING_ADMIN", "OPS_ADMIN")).toBe(false);
    expect(canGrantRole("OPS_ADMIN", "BILLING_ADMIN")).toBe(false);
  });

  it("USER (empty permission set) can only ever grant USER", () => {
    expect(canGrantRole("USER", "USER")).toBe(true);
    expect(canGrantRole("USER", "ANALYST")).toBe(false);
  });

  it("CONTENT_ADMIN cannot grant SUPPORT_ADMIN (SUPPORT_ADMIN holds user:suspend and crawl:retry, which CONTENT_ADMIN lacks)", () => {
    expect(canGrantRole("CONTENT_ADMIN", "SUPPORT_ADMIN")).toBe(false);
  });

  it("MANAGER can grant SUPPORT_ADMIN and OPS_ADMIN (its own set is their union) but not MARKETING_ADMIN (campaign:* is disjoint)", () => {
    expect(canGrantRole("MANAGER", "SUPPORT_ADMIN")).toBe(true);
    expect(canGrantRole("MANAGER", "OPS_ADMIN")).toBe(true);
    expect(canGrantRole("MANAGER", "MARKETING_ADMIN")).toBe(false);
  });
});

describe("effectivePermissions — Milestone 12 §2.1, additive-only union", () => {
  it("with no grants, effective permissions equal the role's own set exactly", () => {
    for (const role of ROLES) {
      expect(effectivePermissions(role, [])).toEqual(new Set(permissionsFor(role)));
    }
  });

  it("a grant widens the effective set beyond the role's baseline", () => {
    const effective = effectivePermissions("CONTENT_ADMIN", ["crawl:retry"]);
    expect(effective.has("crawl:retry")).toBe(true); // granted, not in CONTENT_ADMIN's own set
    expect(effective.has("metrics:read")).toBe(true); // still has its role-derived permissions
    expect(effective.has("user:role:write")).toBe(false); // never granted here, never present
  });

  it("granting a permission the role already has is a harmless no-op on the resulting set (Set dedup, no double-counting)", () => {
    const effective = effectivePermissions("SUPPORT_ADMIN", ["user:read"]); // SUPPORT_ADMIN already has user:read
    expect(effective.has("user:read")).toBe(true);
    expect([...effective].filter((p) => p === "user:read")).toHaveLength(1);
  });

  it("passing zero grants never removes a role-derived permission — additive only, no code path narrows", () => {
    const withGrants = effectivePermissions("USER", []);
    expect(withGrants).toEqual(new Set());
  });
});

describe("SUPER_ADMIN_ONLY — Milestone 12 §2.2", () => {
  it("every SUPER_ADMIN_ONLY permission is held by SUPER_ADMIN's own baseline matrix — otherwise it would be unreachable by anyone", () => {
    for (const permission of SUPER_ADMIN_ONLY) {
      expect(hasPermission("SUPER_ADMIN", permission)).toBe(true);
    }
  });

  it("no role OTHER than SUPER_ADMIN holds any SUPER_ADMIN_ONLY permission in its baseline matrix", () => {
    for (const role of ROLES) {
      if (role === "SUPER_ADMIN") continue;
      for (const permission of SUPER_ADMIN_ONLY) {
        expect(hasPermission(role, permission)).toBe(false);
      }
    }
  });

  it("contains exactly the doc's own §2.2 list", () => {
    expect(new Set(SUPER_ADMIN_ONLY)).toEqual(
      new Set([
        "user:role:write",
        "promo:create",
        "promo:assign",
        "promo:revoke",
        "billing:provider:write",
        "billing:refund",
        "billing:payout:read",
        "integration:credentials:write",
        "permission:grant",
      ]),
    );
  });
});
