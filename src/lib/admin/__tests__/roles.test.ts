import { describe, expect, it } from "vitest";
import { canGrantRole, hasPermission, permissionsFor, type Permission, type Role } from "../roles";

const ROLES: Role[] = ["USER", "ANALYST", "CONTENT_ADMIN", "SUPPORT_ADMIN", "BILLING_ADMIN", "OPS_ADMIN", "SUPER_ADMIN"];
const PERMISSIONS: Permission[] = [
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
];

/**
 * The literal expected table from docs/milestone-11-security-rbac-promos.md
 * section 2.1 — every role/permission pair is asserted individually so an
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
});
