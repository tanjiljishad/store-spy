import { createHmac } from "node:crypto";
import { constantTimeEqual } from "../security/constant-time-equal";

/**
 * Milestone 12 §4.1: "UnsubscribeToken per user (or an HMAC of the user id
 * with a dedicated secret), giving a one-click unsubscribe that requires no
 * login." Chose the HMAC form, not a stored-token table: no email SENDER
 * exists anywhere in this codebase yet (M12's own doc lists "transactional
 * or marketing email sending" as explicitly out of scope — only consent
 * capture and the unsubscribe MECHANISM are in scope this phase), so
 * there's nothing that would ever need to look up or revoke an individual
 * token row; a stateless, deterministic HMAC is strictly simpler and has no
 * table to prune. `verifyUnsubscribeToken()` is what `GET /unsubscribe`
 * checks — see that page for the no-login flow.
 *
 * `UNSUBSCRIBE_TOKEN_SECRET` is a DEDICATED secret, not AUTH_SECRET reused —
 * same "unique per environment, never shared" reasoning as AUTH_SECRET
 * itself: a leaked unsubscribe link should never also compromise session
 * signing, and vice versa. Fails CLOSED the same way turnstile.ts and
 * SCHEDULER_SECRET do: an unset secret makes every token invalid rather
 * than silently trusting an unsigned request.
 */

function getSecret(): string | null {
  return process.env.UNSUBSCRIBE_TOKEN_SECRET ?? null;
}

function computeHmac(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(userId, "utf8").digest("hex");
}

/** Null if `UNSUBSCRIBE_TOKEN_SECRET` is unset — callers must treat that as "cannot mint a working link," not silently emit a token nothing can ever verify. */
export function generateUnsubscribeToken(userId: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return computeHmac(userId, secret);
}

export function verifyUnsubscribeToken(userId: string, token: string | null | undefined): boolean {
  const secret = getSecret();
  if (!secret || !token) return false;
  return constantTimeEqual(computeHmac(userId, secret), token);
}
