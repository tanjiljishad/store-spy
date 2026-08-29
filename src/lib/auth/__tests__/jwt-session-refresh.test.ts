import { describe, expect, it, vi } from "vitest";
import {
  SESSION_CHECK_TTL_MS,
  refreshSessionToken,
  type JwtTokenState,
  type UserSessionSnapshot,
} from "../jwt-session-refresh";

function readUserReturning(snapshot: UserSessionSnapshot | null) {
  return vi.fn(async () => snapshot);
}

describe("refreshSessionToken", () => {
  it("passes through unchanged when there is no id at all (never signed in)", async () => {
    const readUser = readUserReturning(null);
    const result = await refreshSessionToken({}, false, readUser);
    expect(result).toEqual({});
    expect(readUser).not.toHaveBeenCalled();
  });

  it("fresh sign-in always does a live read and stamps sessionCheckedAt", async () => {
    const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
    const now = 1_000_000;
    const result = await refreshSessionToken({ id: "u1" }, true, readUser, now);
    expect(result).toMatchObject({ id: "u1", role: "USER", sessionCheckedAt: now });
    expect(readUser).toHaveBeenCalledWith("u1");
  });

  it("fresh sign-in defaults to USER when the user row is somehow missing", async () => {
    const readUser = readUserReturning(null);
    const result = await refreshSessionToken({ id: "u1" }, true, readUser, 1000);
    expect(result.role).toBe("USER");
    expect(result.id).toBe("u1");
  });

  it("skips the DB read entirely for a USER-role token while the cached value is still within the TTL", async () => {
    const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
    const now = 1_000_000;
    const token = { id: "u1", role: "USER", sessionCheckedAt: now - (SESSION_CHECK_TTL_MS - 1) };
    const result = await refreshSessionToken(token, false, readUser, now);
    expect(result).toBe(token); // unchanged, same reference
    expect(readUser).not.toHaveBeenCalled();
  });

  it("re-reads a USER-role token once the cached value is past the TTL", async () => {
    const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
    const now = 1_000_000;
    const token = { id: "u1", role: "USER", sessionCheckedAt: now - SESSION_CHECK_TTL_MS };
    const result = await refreshSessionToken(token, false, readUser, now);
    expect(readUser).toHaveBeenCalledWith("u1");
    expect(result).toMatchObject({ role: "USER", sessionCheckedAt: now });
  });

  it("collapses to anonymous (drops id) when the user row no longer exists", async () => {
    const readUser = readUserReturning(null);
    const now = 1_000_000;
    const token = { id: "u1", role: "USER", sessionCheckedAt: now - SESSION_CHECK_TTL_MS };
    const result = await refreshSessionToken(token, false, readUser, now);
    expect(result.id).toBeUndefined();
  });

  it("rejects (drops id) a token issued before sessions_valid_after — the real 'sign out everywhere'", async () => {
    const revokedAt = new Date(1_000_000);
    const readUser = readUserReturning({ role: "USER", sessionsValidAfter: revokedAt });
    const now = revokedAt.getTime() + SESSION_CHECK_TTL_MS + 1;
    // Token was issued (iat, in SECONDS) before the revocation timestamp.
    const token = { id: "u1", role: "USER", sessionCheckedAt: 0, iat: Math.floor((revokedAt.getTime() - 5000) / 1000) };
    const result = await refreshSessionToken(token, false, readUser, now);
    expect(result.id).toBeUndefined();
  });

  it("accepts a token issued AFTER sessions_valid_after — a real re-login is never rejected", async () => {
    const revokedAt = new Date(1_000_000);
    const readUser = readUserReturning({ role: "USER", sessionsValidAfter: revokedAt });
    const now = revokedAt.getTime() + SESSION_CHECK_TTL_MS + 1;
    const token = { id: "u1", role: "USER", sessionCheckedAt: 0, iat: Math.floor((revokedAt.getTime() + 5000) / 1000) };
    const result = await refreshSessionToken(token, false, readUser, now);
    expect(result.id).toBe("u1");
  });

  it("a fresh sign-in is NEVER subject to the sessionsValidAfter check, even with iat effectively 0", async () => {
    const readUser = readUserReturning({ role: "USER", sessionsValidAfter: new Date(999_999_999_999) });
    // No `iat` at all yet — this is exactly the shape of the token object
    // the very first time the jwt callback runs for a brand-new sign-in.
    const result = await refreshSessionToken({ id: "u1" }, true, readUser, 1_000_000);
    expect(result.id).toBe("u1");
  });

  describe("pre-cutover JWT survives the B2 2·B cutover", () => {
    // A token minted by the PRE-cutover jwt callback carries `plan` and
    // `planCheckedAt` and has NO `sessionCheckedAt`. After the cutover the
    // callback must still authorise it: the account exists in
    // control_plane.users, nobody has revoked it, so the session holds. The
    // stale `plan` / `planCheckedAt` claims ride along harmlessly and are
    // never read.
    const preCutoverToken = () => ({
      id: "u1",
      plan: "BASIC",
      role: "USER",
      planCheckedAt: 1_000_000,
      iat: Math.floor(1_000_000 / 1000),
    });

    it("keeps the session (id retained) and re-stamps sessionCheckedAt", async () => {
      const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
      const now = 5_000_000; // well past any plausible TTL of the absent sessionCheckedAt
      const result = await refreshSessionToken(preCutoverToken(), false, readUser, now);

      expect(readUser).toHaveBeenCalledWith("u1"); // absent sessionCheckedAt reads as 0 → stale → live re-read
      expect(result.id).toBe("u1"); // NOT collapsed to anonymous
      expect(result.role).toBe("USER");
      expect(result.sessionCheckedAt).toBe(now);
    });

    it("still rejects a pre-cutover token that predates a later revocation", async () => {
      const revokedAt = new Date(2_000_000);
      const readUser = readUserReturning({ role: "USER", sessionsValidAfter: revokedAt });
      const result = await refreshSessionToken(preCutoverToken(), false, readUser, 5_000_000);
      expect(result.id).toBeUndefined();
    });

    it("re-reads and corrects a pre-cutover privileged token from the control plane", async () => {
      const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
      const token = { ...preCutoverToken(), role: "OPS_ADMIN" };
      const result = await refreshSessionToken(token, false, readUser, 5_000_000);
      expect(readUser).toHaveBeenCalledWith("u1");
      expect(result.role).toBe("USER");
    });
  });

  describe("privileged roles bypass the TTL cache (Phase 2 amendment)", () => {
    it("a token carrying role: SUPER_ADMIN for a user whose DB row says USER is corrected on the very next request, with no delay", async () => {
      // The token's OWN sessionCheckedAt claims to be perfectly fresh — an
      // attacker forging a token controls this claim too. If the TTL cache
      // were honored here, this forged privileged role would never be
      // revalidated. It must not be.
      const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
      const now = 1_000_000;
      const token = { id: "u1", role: "SUPER_ADMIN", sessionCheckedAt: now }; // "just checked" — forged

      const result = await refreshSessionToken(token, false, readUser, now);

      expect(readUser).toHaveBeenCalledWith("u1"); // re-read happened despite sessionCheckedAt === now
      expect(result.role).toBe("USER"); // corrected from the database, not trusted from the token
    });

    it("re-reads a privileged role on every call, never caching it even a second time", async () => {
      const readUser = readUserReturning({ role: "SUPER_ADMIN", sessionsValidAfter: null });
      const now = 1_000_000;
      let token: JwtTokenState = { id: "u1", role: "SUPER_ADMIN", sessionCheckedAt: now };

      token = await refreshSessionToken(token, false, readUser, now + 1);
      token = await refreshSessionToken(token, false, readUser, now + 2);
      token = await refreshSessionToken(token, false, readUser, now + 3);

      expect(readUser).toHaveBeenCalledTimes(3);
    });

    it("a USER-role token is unaffected — still cached normally within the TTL", async () => {
      const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
      const now = 1_000_000;
      const token = { id: "u1", role: "USER", sessionCheckedAt: now - 1 };

      const result = await refreshSessionToken(token, false, readUser, now);

      expect(readUser).not.toHaveBeenCalled();
      expect(result).toBe(token);
    });

    it("a role downgraded from privileged to USER during a forced re-read returns to normal TTL caching afterward", async () => {
      const readUser = readUserReturning({ role: "USER", sessionsValidAfter: null });
      const now = 1_000_000;
      const token = { id: "u1", role: "OPS_ADMIN", sessionCheckedAt: now };

      const afterDowngrade = await refreshSessionToken(token, false, readUser, now + 1);
      expect(afterDowngrade.role).toBe("USER");

      readUser.mockClear();
      const stillCached = await refreshSessionToken(afterDowngrade, false, readUser, now + 2);
      expect(readUser).not.toHaveBeenCalled(); // now caches normally, since the effective role is USER
      expect(stillCached).toBe(afterDowngrade);
    });

    it("also enforces sessionsValidAfter on the forced privileged-role re-read path", async () => {
      const revokedAt = new Date(1_000_000);
      const readUser = readUserReturning({ role: "SUPER_ADMIN", sessionsValidAfter: revokedAt });
      const now = revokedAt.getTime() + 1;
      const token = {
        id: "u1",
        role: "SUPER_ADMIN",
        sessionCheckedAt: now,
        iat: Math.floor((revokedAt.getTime() - 5000) / 1000),
      };

      const result = await refreshSessionToken(token, false, readUser, now);
      expect(result.id).toBeUndefined(); // revoked, even for a currently-valid-looking SUPER_ADMIN token
    });
  });
});
