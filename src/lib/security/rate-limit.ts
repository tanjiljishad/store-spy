/**
 * In-memory, single-process rate limiter — a fixed window per key. This is
 * the correct amount of infrastructure for a milestone-1 deployment running
 * as one server process. It is NOT safe across multiple instances (each
 * process has its own counters, so N instances effectively multiply the
 * limit by N) — a real multi-instance deployment needs a shared store
 * (Redis, etc.) instead. Flagging that now so it isn't discovered in
 * production traffic.
 */

interface Bucket {
  count: number;
  windowStart: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

const buckets = new Map<string, Bucket>();

let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Bounds memory without a timer (which can misbehave across deploy targets). */
function sweepExpired(windowMs: number, now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  sweepExpired(opts.windowMs, now);

  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= opts.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: opts.limit - 1, retryAfterMs: 0 };
  }

  if (existing.count >= opts.limit) {
    return { allowed: false, remaining: 0, retryAfterMs: opts.windowMs - (now - existing.windowStart) };
  }

  existing.count++;
  return { allowed: true, remaining: opts.limit - existing.count, retryAfterMs: 0 };
}

/** Test-only: clears all counters so tests don't leak state into each other. */
export function _resetRateLimitState(): void {
  buckets.clear();
}

/**
 * Best-effort client IP extraction. x-forwarded-for is attacker-controllable
 * unless your edge/proxy layer strips and re-sets it (Vercel's does) — this
 * is fine as a rate-limit key (worst case, a spoofed value just gets its own
 * bucket) but must never be trusted for anything security-critical like
 * access control.
 */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
