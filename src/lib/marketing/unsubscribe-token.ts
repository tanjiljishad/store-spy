import { createSignedToken, verifySignedToken } from "../security/signed-token";

/**
 * Milestone 12 §4.1: a one-click, no-login unsubscribe link. Stateless (no
 * stored-token table — nothing sends marketing email yet, so there is nothing
 * that would need to look one up or revoke it) but TIME-BOUNDED — see
 * security/signed-token.ts.
 *
 * Audit fix M-4: this was a bare deterministic HMAC of the user id with no
 * expiry. It now carries a signed issued-at time and lapses after
 * UNSUBSCRIBE_TOKEN_MAX_AGE_MS. The window is deliberately generous — an
 * opt-out link should keep working for a good while — and `/unsubscribe`
 * already shows a "sign in and update your preferences" fallback when a link
 * no longer verifies.
 *
 * `UNSUBSCRIBE_TOKEN_SECRET` is a DEDICATED secret, never AUTH_SECRET reused.
 * Fails CLOSED: an unset secret makes every token invalid.
 */

/** 90 days — an unsubscribe link on an old email should still work; a lapsed one falls through to the signed-in preferences page. */
export const UNSUBSCRIBE_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function getSecret(): string | null {
  return process.env.UNSUBSCRIBE_TOKEN_SECRET ?? null;
}

/** Null if `UNSUBSCRIBE_TOKEN_SECRET` is unset — callers must treat that as "cannot mint a working link," not silently emit a token nothing can ever verify. */
export function generateUnsubscribeToken(userId: string, now: number = Date.now()): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return createSignedToken(secret, userId, now);
}

export function verifyUnsubscribeToken(userId: string, token: string | null | undefined, now: number = Date.now()): boolean {
  const secret = getSecret();
  if (!secret || !token) return false;
  return verifySignedToken(secret, userId, token, UNSUBSCRIBE_TOKEN_MAX_AGE_MS, now);
}
