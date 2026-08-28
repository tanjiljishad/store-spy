import { createHmac } from "node:crypto";
import { constantTimeEqual } from "../security/constant-time-equal";

/**
 * Same stateless-HMAC design as marketing/unsubscribe-token.ts: no stored-
 * token table, since a deterministic HMAC needs nothing to look up or prune.
 * Bound to `${userId}:${email}`, not just the user id — the unsubscribe
 * token can get away with id-only because there is no account-email-change
 * feature to worry about invalidating; this one includes the email so that,
 * if an email-change feature is ever added, a token minted for the old
 * address stops verifying instead of silently re-confirming a different one.
 *
 * `EMAIL_VERIFICATION_TOKEN_SECRET` is a DEDICATED secret — same "unique per
 * environment, never shared, never AUTH_SECRET reused" reasoning as
 * UNSUBSCRIBE_TOKEN_SECRET. Fails CLOSED: an unset secret makes every token
 * invalid rather than silently trusting an unsigned request.
 */

function getSecret(): string | null {
  return process.env.EMAIL_VERIFICATION_TOKEN_SECRET ?? null;
}

function computeHmac(userId: string, email: string, secret: string): string {
  return createHmac("sha256", secret).update(`${userId}:${email}`, "utf8").digest("hex");
}

/** Null if `EMAIL_VERIFICATION_TOKEN_SECRET` is unset — callers must treat that as "cannot mint a working link," not silently emit a token nothing can ever verify. */
export function generateEmailVerificationToken(userId: string, email: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return computeHmac(userId, email, secret);
}

export function verifyEmailVerificationToken(userId: string, email: string, token: string | null | undefined): boolean {
  const secret = getSecret();
  if (!secret || !token) return false;
  return constantTimeEqual(computeHmac(userId, email, secret), token);
}
