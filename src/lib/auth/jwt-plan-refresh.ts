/**
 * The `jwt` callback's re-read/TTL/revocation logic, factored out of
 * auth.ts for the same reason verify-credentials.ts and
 * authorize-credentials.ts are (see their own doc comments): directly
 * unit-testable without going through NextAuth's own request pipeline.
 * `readUser` is injected so this has no Prisma dependency of its own —
 * same Prisma-free-pure-module convention as plan-limits.ts.
 *
 * Milestone 11, Phase 2 amendment (post-Phase-1 review — see the doc's own
 * 2.2 amendment): `role` does NOT share `plan`'s 60-second TTL cache. The
 * TTL works by comparing a `planCheckedAt` claim inside the token itself —
 * an attacker who has forged a token controls that claim too, and can keep
 * it permanently "fresh" so the DB re-read that would catch the forgery
 * never fires. A forged SUPER_ADMIN token would never be revalidated.
 * Fix: whenever the token's CURRENT `role` claim is anything other than
 * `"USER"`, this re-reads on every single call, ignoring `planCheckedAt`
 * entirely, and overwrites `role` from the database — so a forged or
 * stale privileged role is corrected on the very next request, not within
 * some window. The TTL still applies to `plan`, and to `role` itself, but
 * ONLY while the token's own current role claim is `"USER"` (the common
 * case — regular users are the overwhelming majority of traffic; admin
 * traffic is a rounding error, so the extra query cost here is irrelevant).
 */

/** Re-exported by auth.ts too — one source of truth for the TTL value. */
export const PLAN_CHECK_TTL_MS = 60_000;

export interface JwtTokenState {
  id?: string;
  plan?: string;
  role?: string;
  planCheckedAt?: number;
  /** Seconds since epoch — set by Auth.js's encode(), not by this app. */
  iat?: number;
  [key: string]: unknown;
}

export interface UserPlanSnapshot {
  plan: string;
  role: string;
  sessionsValidAfter: Date | null;
}

/**
 * `token.id` must already be set by the caller before this runs on a fresh
 * sign-in (auth.ts does `if (user) token.id = user.id` first) — this
 * function only decides whether/how to re-read and whether to reject.
 *
 * - Fresh sign-in: always a live read, never subject to the revocation
 *   check below — a token being minted right now cannot have been "issued
 *   before" a past revocation in any meaningful sense.
 * - No id at all: nothing to do, pass through unchanged.
 * - Privileged current role (anything but "USER"): ALWAYS re-read, TTL
 *   ignored — see the module doc comment above.
 * - "USER" role, cached and still fresh (within PLAN_CHECK_TTL_MS): pass
 *   through unchanged.
 * - Otherwise stale: re-read. A deleted account, or a token issued before
 *   User.sessionsValidAfter, has its `id` stripped — collapsing the
 *   session to anonymous (see auth.ts's own doc comment on why this is the
 *   mechanism, not a thrown error or a null return). Any other re-read
 *   overwrites both `plan` and `role` from the database.
 */
export async function refreshJwtToken(
  token: JwtTokenState,
  isFreshSignIn: boolean,
  readUser: (userId: string) => Promise<UserPlanSnapshot | null>,
  now: number = Date.now(),
): Promise<JwtTokenState> {
  if (!token.id) return token;

  if (isFreshSignIn) {
    const dbUser = await readUser(token.id);
    return { ...token, plan: dbUser?.plan ?? "FREE", role: dbUser?.role ?? "USER", planCheckedAt: now };
  }

  const currentRole = typeof token.role === "string" ? token.role : "USER";
  const isPrivileged = currentRole !== "USER";

  const checkedAt = typeof token.planCheckedAt === "number" ? token.planCheckedAt : 0;
  const cacheIsFresh = !isPrivileged && now - checkedAt < PLAN_CHECK_TTL_MS;
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

  return { ...token, plan: dbUser.plan, role: dbUser.role, planCheckedAt: now };
}
