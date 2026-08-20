/**
 * Pure login-throttle policy — how many recent failures, in what window,
 * turn into a slowdown or a hard lock. Deliberately Prisma-free (same
 * convention as plan-limits.ts and monitoring/policy.ts): the caller
 * (login-throttle.ts) does the counting against the database; this module
 * only turns two counts into a decision, so it's unit-testable with no DB.
 *
 * There is no separate "lockedUntil" timestamp anywhere: a lock is just
 * "10+ failures still inside the window," which un-locks itself the moment
 * enough time passes that the oldest of those failures ages out — the same
 * windowed COUNT that triggered the lock is what releases it. One
 * mechanism, not two that could drift out of sync.
 */

/** Shared by both dimensions — see the doc comment above for why one window covers both. */
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60_000;

const EMAIL_DELAY_THRESHOLD = 5;
const EMAIL_LOCK_THRESHOLD = 10;
/** Looser than the per-email threshold — a shared NAT/office network hitting many different accounts is normal traffic, not an attack. */
const IP_LOCK_THRESHOLD = 30;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

export interface LoginThrottleCounts {
  /** Failed attempts for this normalized email, inside LOGIN_ATTEMPT_WINDOW_MS. */
  emailFailuresInWindow: number;
  /** Failed attempts from this client IP (any email), inside LOGIN_ATTEMPT_WINDOW_MS. */
  ipFailuresInWindow: number;
}

export type LoginThrottleDecision =
  | { outcome: "allow"; delayMs: number }
  | { outcome: "locked" };

/**
 * `delayMs` doubles for each failure past the delay threshold, capped —
 * the same exponential-with-ceiling shape as monitoring/policy.ts's crawl
 * backoff, for a familiar curve rather than a bespoke one.
 */
export function evaluateLoginThrottle(counts: LoginThrottleCounts): LoginThrottleDecision {
  if (counts.emailFailuresInWindow >= EMAIL_LOCK_THRESHOLD) return { outcome: "locked" };
  if (counts.ipFailuresInWindow >= IP_LOCK_THRESHOLD) return { outcome: "locked" };

  if (counts.emailFailuresInWindow >= EMAIL_DELAY_THRESHOLD) {
    const stepsPastThreshold = counts.emailFailuresInWindow - EMAIL_DELAY_THRESHOLD;
    const delayMs = Math.min(BASE_DELAY_MS * 2 ** stepsPastThreshold, MAX_DELAY_MS);
    return { outcome: "allow", delayMs };
  }

  return { outcome: "allow", delayMs: 0 };
}
