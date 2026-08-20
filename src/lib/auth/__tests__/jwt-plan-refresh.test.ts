import { describe, expect, it, vi } from "vitest";
import { PLAN_CHECK_TTL_MS, refreshJwtToken, type JwtTokenState, type UserPlanSnapshot } from "../jwt-plan-refresh";

function readUserReturning(snapshot: UserPlanSnapshot | null) {
  return vi.fn(async () => snapshot);
}

describe("refreshJwtToken", () => {
  it("passes through unchanged when there is no id at all (never signed in)", async () => {
    const readUser = readUserReturning(null);
    const result = await refreshJwtToken({}, false, readUser);
    expect(result).toEqual({});
    expect(readUser).not.toHaveBeenCalled();
  });

  it("fresh sign-in always does a live read and stamps planCheckedAt", async () => {
    const readUser = readUserReturning({ plan: "BASIC", role: "USER", sessionsValidAfter: null });
    const now = 1_000_000;
    const result = await refreshJwtToken({ id: "u1" }, true, readUser, now);
    expect(result).toMatchObject({ id: "u1", plan: "BASIC", role: "USER", planCheckedAt: now });
    expect(readUser).toHaveBeenCalledWith("u1");
  });

  it("fresh sign-in defaults to FREE/USER when the user row is somehow missing", async () => {
    const readUser = readUserReturning(null);
    const result = await refreshJwtToken({ id: "u1" }, true, readUser, 1000);
    expect(result.plan).toBe("FREE");
    expect(result.role).toBe("USER");
  });

  it("skips the DB read entirely for a USER-role token while the cached value is still within the TTL", async () => {
    const readUser = readUserReturning({ plan: "BASIC", role: "USER", sessionsValidAfter: null });
    const now = 1_000_000;
    const token = { id: "u1", plan: "FREE", role: "USER", planCheckedAt: now - (PLAN_CHECK_TTL_MS - 1) };
    const result = await refreshJwtToken(token, false, readUser, now);
    expect(result).toBe(token); // unchanged, same reference
    expect(readUser).not.toHaveBeenCalled();
  });

  it("re-reads a USER-role token once the cached value is past the TTL", async () => {
    const readUser = readUserReturning({ plan: "BUSINESS", role: "USER", sessionsValidAfter: null });
    const now = 1_000_000;
    const token = { id: "u1", plan: "FREE", role: "USER", planCheckedAt: now - PLAN_CHECK_TTL_MS };
    const result = await refreshJwtToken(token, false, readUser, now);
    expect(readUser).toHaveBeenCalledWith("u1");
    expect(result).toMatchObject({ plan: "BUSINESS", role: "USER", planCheckedAt: now });
  });

  it("collapses to anonymous (drops id) when the user row no longer exists", async () => {
    const readUser = readUserReturning(null);
    const now = 1_000_000;
    const token = { id: "u1", plan: "FREE", role: "USER", planCheckedAt: now - PLAN_CHECK_TTL_MS };
    const result = await refreshJwtToken(token, false, readUser, now);
    expect(result.id).toBeUndefined();
  });

  it("rejects (drops id) a token issued before User.sessionsValidAfter — the real 'sign out everywhere'", async () => {
    const revokedAt = new Date(1_000_000);
    const readUser = readUserReturning({ plan: "FREE", role: "USER", sessionsValidAfter: revokedAt });
    const now = revokedAt.getTime() + PLAN_CHECK_TTL_MS + 1;
    // Token was issued (iat, in SECONDS) before the revocation timestamp.
    const token = { id: "u1", plan: "FREE", role: "USER", planCheckedAt: 0, iat: Math.floor((revokedAt.getTime() - 5000) / 1000) };
    const result = await refreshJwtToken(token, false, readUser, now);
    expect(result.id).toBeUndefined();
  });

  it("accepts a token issued AFTER User.sessionsValidAfter — a real re-login is never rejected", async () => {
    const revokedAt = new Date(1_000_000);
    const readUser = readUserReturning({ plan: "FREE", role: "USER", sessionsValidAfter: revokedAt });
    const now = revokedAt.getTime() + PLAN_CHECK_TTL_MS + 1;
    const token = { id: "u1", plan: "FREE", role: "USER", planCheckedAt: 0, iat: Math.floor((revokedAt.getTime() + 5000) / 1000) };
    const result = await refreshJwtToken(token, false, readUser, now);
    expect(result.id).toBe("u1");
    expect(result.plan).toBe("FREE");
  });

  it("a fresh sign-in is NEVER subject to the sessionsValidAfter check, even with iat effectively 0", async () => {
    const readUser = readUserReturning({ plan: "FREE", role: "USER", sessionsValidAfter: new Date(999_999_999_999) });
    // No `iat` at all yet — this is exactly the shape of the token object
    // the very first time the jwt callback runs for a brand-new sign-in.
    const result = await refreshJwtToken({ id: "u1" }, true, readUser, 1_000_000);
    expect(result.id).toBe("u1");
  });

  describe("privileged roles bypass the TTL cache (Phase 2 amendment)", () => {
    it("a token carrying role: SUPER_ADMIN for a user whose DB row says USER is corrected on the very next request, with no delay", async () => {
      // The token's OWN planCheckedAt claims to be perfectly fresh — an
      // attacker forging a token controls this claim too. If the TTL cache
      // were honored here, this forged privileged role would never be
      // revalidated. It must not be.
      const readUser = readUserReturning({ plan: "FREE", role: "USER", sessionsValidAfter: null });
      const now = 1_000_000;
      const token = { id: "u1", plan: "FREE", role: "SUPER_ADMIN", planCheckedAt: now }; // "just checked" — forged

      const result = await refreshJwtToken(token, false, readUser, now);

      expect(readUser).toHaveBeenCalledWith("u1"); // re-read happened despite planCheckedAt === now
      expect(result.role).toBe("USER"); // corrected from the database, not trusted from the token
    });

    it("re-reads a privileged role on every call, never caching it even a second time", async () => {
      const readUser = readUserReturning({ plan: "FREE", role: "SUPER_ADMIN", sessionsValidAfter: null });
      const now = 1_000_000;
      let token: JwtTokenState = { id: "u1", plan: "FREE", role: "SUPER_ADMIN", planCheckedAt: now };

      token = await refreshJwtToken(token, false, readUser, now + 1);
      token = await refreshJwtToken(token, false, readUser, now + 2);
      token = await refreshJwtToken(token, false, readUser, now + 3);

      expect(readUser).toHaveBeenCalledTimes(3);
    });

    it("a USER-role token is unaffected — still cached normally within the TTL", async () => {
      const readUser = readUserReturning({ plan: "FREE", role: "USER", sessionsValidAfter: null });
      const now = 1_000_000;
      const token = { id: "u1", plan: "FREE", role: "USER", planCheckedAt: now - 1 };

      const result = await refreshJwtToken(token, false, readUser, now);

      expect(readUser).not.toHaveBeenCalled();
      expect(result).toBe(token);
    });

    it("a role downgraded from privileged to USER during a forced re-read returns to normal TTL caching afterward", async () => {
      const readUser = readUserReturning({ plan: "FREE", role: "USER", sessionsValidAfter: null });
      const now = 1_000_000;
      const token = { id: "u1", plan: "FREE", role: "OPS_ADMIN", planCheckedAt: now };

      const afterDowngrade = await refreshJwtToken(token, false, readUser, now + 1);
      expect(afterDowngrade.role).toBe("USER");

      readUser.mockClear();
      const stillCached = await refreshJwtToken(afterDowngrade, false, readUser, now + 2);
      expect(readUser).not.toHaveBeenCalled(); // now caches normally, since the effective role is USER
      expect(stillCached).toBe(afterDowngrade);
    });

    it("also enforces sessionsValidAfter on the forced privileged-role re-read path", async () => {
      const revokedAt = new Date(1_000_000);
      const readUser = readUserReturning({ plan: "FREE", role: "SUPER_ADMIN", sessionsValidAfter: revokedAt });
      const now = revokedAt.getTime() + 1;
      const token = {
        id: "u1",
        plan: "FREE",
        role: "SUPER_ADMIN",
        planCheckedAt: now,
        iat: Math.floor((revokedAt.getTime() - 5000) / 1000),
      };

      const result = await refreshJwtToken(token, false, readUser, now);
      expect(result.id).toBeUndefined(); // revoked, even for a currently-valid-looking SUPER_ADMIN token
    });
  });
});
