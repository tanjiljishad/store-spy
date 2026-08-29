/**
 * The `jwt` callback's re-read / TTL / revocation logic, factored out of
 * auth.ts (see verify-credentials.ts / authorize-credentials.ts for the same
 * reasoning): directly unit-testable without going through NextAuth's request
 * pipeline. `readUser` is injected so this has no Prisma dependency of its own.
 *
 * B2 2·B: `plan` no longer lives in the JWT. Entitlement is fetched
 * per-feature from the control plane at gate-check time, so there is nothing
 * to cache and no staleness window — a plan change takes effect on the next
 * gated action. This function is now about EXISTENCE + REVOCATION only:
 *
 *  - It re-reads `control_plane.users` on a TTL to catch a deleted account or
 *    a token issued before `sessions_valid_after` (the "sign out everywhere"
 *    floor), stripping `id` — collapsing the session to anonymous — in either
 *    case.
 *  - `role` (still a JWT claim; the staff/customer split is B2.5) keeps its
 *    Milestone-11 anti-forgery rule: whenever the token's CURRENT `role` claim
 *    is anything other than `"USER"`, re-read on every call, TTL ignored, and
 *    overwrite `role` from the DB — a forged privileged token cannot keep its
 *    own `sessionCheckedAt` "fresh" to dodge revalidation.
 */

/** Re-exported by auth.ts — one source of truth for the TTL value. Unchanged 60s. */
export const SESSION_CHECK_TTL_MS = 60_000;

export interface JwtTokenState {
  id?: string;
  role?: string;
  sessionCheckedAt?: number;
  /** Seconds since epoch — set by Auth.js's encode(), not by this app. */
  iat?: number;
  [key: string]: unknown;
}

export interface UserSessionSnapshot {
  role: string;
  sessionsValidAfter: Date | null;
}

/**
 * `token.id` must already be set by the caller before this runs on a fresh
 * sign-in (auth.ts does `if (user) token.id = user.id` first) — this function
 * only decides whether/how to re-read and whether to reject.
 *
 * - Fresh sign-in: always a live read, never subject to the revocation check
 *   (a token minted right now cannot predate a past revocation).
 * - No id: nothing to do, pass through.
 * - Privileged current role: ALWAYS re-read, TTL ignored.
 * - `"USER"` role, checked within SESSION_CHECK_TTL_MS: pass through.
 * - Otherwise: re-read. Deleted account, or token issued before
 *   `sessions_valid_after` → strip `id`. Any other re-read overwrites `role`.
 */
export async function refreshSessionToken(
  token: JwtTokenState,
  isFreshSignIn: boolean,
  readUser: (userId: string) => Promise<UserSessionSnapshot | null>,
  now: number = Date.now(),
): Promise<JwtTokenState> {
  if (!token.id) return token;

  if (isFreshSignIn) {
    const dbUser = await readUser(token.id);
    return { ...token, role: dbUser?.role ?? "USER", sessionCheckedAt: now };
  }

  const currentRole = typeof token.role === "string" ? token.role : "USER";
  const isPrivileged = currentRole !== "USER";

  const checkedAt = typeof token.sessionCheckedAt === "number" ? token.sessionCheckedAt : 0;
  const cacheIsFresh = !isPrivileged && now - checkedAt < SESSION_CHECK_TTL_MS;
  if (cacheIsFresh) return token;

  const dbUser = await readUser(token.id);
  if (!dbUser) {
    const { id: _id, ...rest } = token;
    return rest;
  }

  const issuedAtMs = typeof token.iat === "number" ? token.iat * 1000 : 0;
  if (dbUser.sessionsValidAfter && issuedAtMs < dbUser.sessionsValidAfter.getTime()) {
    const { id: _id, ...rest } = token;
    return rest;
  }

  return { ...token, role: dbUser.role, sessionCheckedAt: now };
}
