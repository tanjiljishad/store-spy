import ipaddr from "ipaddr.js";

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
 * How many trusted reverse-proxy hops sit in front of this process.
 * `x-forwarded-for` is a comma-separated list the ORIGINAL client can seed
 * with anything it wants; every hop after that only ever APPENDS its own
 * observed peer address, never rewrites what's already there. So the one
 * entry that's actually trustworthy is the Nth from the RIGHT, where N is
 * the number of proxies you know are really there — never the first entry,
 * which is attacker-controlled input, not a proxy observation.
 *
 * Default 1: Render (this app's deployment target, see render.yaml) puts
 * exactly one reverse proxy in front of the web service. `0` means "no
 * proxy at all" — see getClientIp's own comment for why that mode still
 * can't fall back to a real socket address in this framework.
 */
export function parseTrustedProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * The actual XFF parser, factored out so it's unit-testable against literal
 * header strings without touching process.env or a Headers object.
 *
 * - Splits on comma, trims, and drops anything ipaddr.js can't parse as an
 *   IP at all (a spoofed/garbage entry breaks the hop-counting-from-the-end
 *   contract if left in, so it's discarded rather than counted as a hop).
 * - If what's left is shorter than `trustedProxyHops`, the header is either
 *   missing hops a real proxy chain would have added, or lying outright —
 *   either way there's no entry we can trust, so every such request shares
 *   one "unknown" bucket rather than trusting attacker-supplied input.
 */
export function extractClientIp(forwardedFor: string | null, trustedProxyHops: number): string {
  if (trustedProxyHops === 0) return "unknown";
  if (!forwardedFor) return "unknown";

  const candidates = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => ipaddr.isValid(entry));

  if (candidates.length < trustedProxyHops) return "unknown";
  return candidates[candidates.length - trustedProxyHops];
}

/**
 * Best-effort client IP extraction for rate-limit bucketing. Reads
 * `TRUSTED_PROXY_HOPS` (see docs/environment-variables.md) and counts back
 * that many entries from the right of `x-forwarded-for` — the only part of
 * that header a client cannot forge, since every hop between the client and
 * this process only ever appends, never rewrites, earlier entries.
 *
 * `x-real-ip` is deliberately never consulted: it is exactly as spoofable
 * as the first entry of `x-forwarded-for` unless your own proxy is known to
 * set it, and this app's one supported proxy (Render) doesn't — trusting it
 * would just reopen the same hole this function exists to close.
 *
 * Still only a rate-limit key, never an access-control decision: worst case
 * for a successful spoof is the spoofer sharing a bucket with themselves,
 * not bypassing anything security-critical.
 */
export function getClientIp(headers: Headers): string {
  const hops = parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS);
  return extractClientIp(headers.get("x-forwarded-for"), hops);
}
