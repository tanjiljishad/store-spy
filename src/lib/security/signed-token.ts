import { createHmac } from "node:crypto";
import { constantTimeEqual } from "./constant-time-equal";

/**
 * A stateless, TIME-BOUNDED signed token: `v1.<issuedAtMs>.<hmac>`, where the
 * HMAC covers the version, the caller's payload, AND the issued-at time — so
 * none of the three can be altered without invalidating the token. There is no
 * DB row: verification is a pure HMAC recomputation plus a max-age check.
 *
 * Audit fix M-4: the email-verification and unsubscribe links were a bare
 * deterministic `HMAC(secret, payload)` — no expiry, no version, no way to age
 * out a link that leaks (email forwarding, referrer, proxy logs). This adds the
 * TTL. It is NOT single-use — that would require storage and is out of scope;
 * the caller-chosen `maxAgeMs` bounds the exposure window instead.
 *
 * The `v1.` prefix means a legacy bare-hex token (no dots) is cleanly rejected
 * by `verifySignedToken` rather than ambiguously parsed, and leaves room for a
 * future `v2` (e.g. a stored jti for single-use) without a flag day.
 */

const VERSION = "v1";

/** Tolerance for clock skew between the minting process and the verifying one. */
export const SIGNED_TOKEN_CLOCK_SKEW_MS = 60_000;

function mac(secret: string, payload: string, issuedAtMs: number): string {
  return createHmac("sha256", secret).update(`${VERSION}|${payload}|${issuedAtMs}`, "utf8").digest("hex");
}

export function createSignedToken(secret: string, payload: string, now: number = Date.now()): string {
  const issuedAtMs = Math.floor(now);
  return `${VERSION}.${issuedAtMs}.${mac(secret, payload, issuedAtMs)}`;
}

export function verifySignedToken(
  secret: string,
  payload: string,
  token: string | null | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const [, issuedAtStr, provided] = parts;
  // Bounded, all-digits — also stops a pathological huge value from Number()ing
  // to Infinity and sailing through the age check.
  if (!/^\d{1,15}$/.test(issuedAtStr)) return false;
  const issuedAtMs = Number(issuedAtStr);

  if (!constantTimeEqual(mac(secret, payload, issuedAtMs), provided)) return false;

  const age = now - issuedAtMs;
  return age >= -SIGNED_TOKEN_CLOCK_SKEW_MS && age <= maxAgeMs;
}
