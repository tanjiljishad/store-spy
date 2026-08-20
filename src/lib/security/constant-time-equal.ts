import { timingSafeEqual } from "node:crypto";

/**
 * `a !== b` on a secret is a timing side-channel: JS string comparison
 * short-circuits at the first mismatched character, so how LONG a wrong
 * guess takes to reject leaks how many leading characters it got right —
 * enough repeated measurements can recover a fixed secret one character at
 * a time. crypto.timingSafeEqual is the fix, but it throws on a length
 * mismatch instead of returning false, and the length check itself is
 * technically also timing-observable — an accepted tradeoff for this app's
 * fixed-length, high-entropy secrets (SCHEDULER_SECRET, generated via
 * `openssl rand -base64 32`), not a gap worth more machinery to close.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
