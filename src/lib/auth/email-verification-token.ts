import { createSignedToken, verifySignedToken } from "../security/signed-token";

/**
 * The email-confirmation link's token. Stateless (no stored-token table) but
 * TIME-BOUNDED — see security/signed-token.ts. Bound to `${userId}:${email}`,
 * not just the user id, so a token minted for one address stops verifying if
 * that account's email is ever changed.
 *
 * Audit fix M-4: this was a bare deterministic HMAC with no expiry — a link
 * that leaked stayed valid forever. It now carries a signed issued-at time and
 * lapses after EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS; `/verify-email` shows a
 * resend form when a link no longer verifies.
 *
 * `EMAIL_VERIFICATION_TOKEN_SECRET` is a DEDICATED secret — never AUTH_SECRET
 * or UNSUBSCRIBE_TOKEN_SECRET reused. Fails CLOSED: an unset secret makes every
 * token invalid rather than trusting an unsigned request.
 */

/** 72h — long enough to click a link from an email over a weekend; a lapsed link is recoverable via the /verify-email resend form. */
export const EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS = 72 * 60 * 60 * 1000;

function getSecret(): string | null {
  return process.env.EMAIL_VERIFICATION_TOKEN_SECRET ?? null;
}

function payloadFor(userId: string, email: string): string {
  return `${userId}:${email}`;
}

/** Null if `EMAIL_VERIFICATION_TOKEN_SECRET` is unset — callers must treat that as "cannot mint a working link," not silently emit a token nothing can ever verify. */
export function generateEmailVerificationToken(userId: string, email: string, now: number = Date.now()): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return createSignedToken(secret, payloadFor(userId, email), now);
}

export function verifyEmailVerificationToken(
  userId: string,
  email: string,
  token: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const secret = getSecret();
  if (!secret || !token) return false;
  return verifySignedToken(secret, payloadFor(userId, email), token, EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS, now);
}
