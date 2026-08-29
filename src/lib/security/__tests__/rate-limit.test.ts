import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRateLimitState, checkRateLimit, extractClientIp, getClientIp, parseTrustedProxyHops } from "../rate-limit";

beforeEach(() => {
  _resetRateLimitState();
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows requests up to the limit, then blocks", () => {
    const opts = { limit: 3, windowMs: 60_000 };
    expect(checkRateLimit("ip1", opts).allowed).toBe(true);
    expect(checkRateLimit("ip1", opts).allowed).toBe(true);
    expect(checkRateLimit("ip1", opts).allowed).toBe(true);
    const fourth = checkRateLimit("ip1", opts);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks separate keys independently", () => {
    const opts = { limit: 1, windowMs: 60_000 };
    expect(checkRateLimit("ip1", opts).allowed).toBe(true);
    expect(checkRateLimit("ip2", opts).allowed).toBe(true); // different key, own bucket
    expect(checkRateLimit("ip1", opts).allowed).toBe(false); // ip1 already used its one slot
  });

  it("resets after the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const opts = { limit: 1, windowMs: 1000 };
    expect(checkRateLimit("ip1", opts).allowed).toBe(true);
    expect(checkRateLimit("ip1", opts).allowed).toBe(false);

    vi.setSystemTime(1001);
    expect(checkRateLimit("ip1", opts).allowed).toBe(true);
    vi.useRealTimers();
  });

  it("reports decreasing remaining count", () => {
    const opts = { limit: 3, windowMs: 60_000 };
    expect(checkRateLimit("ip1", opts).remaining).toBe(2);
    expect(checkRateLimit("ip1", opts).remaining).toBe(1);
    expect(checkRateLimit("ip1", opts).remaining).toBe(0);
  });
});

describe("parseTrustedProxyHops", () => {
  it("returns null when unset — there is deliberately no default", () => {
    expect(parseTrustedProxyHops(undefined)).toBeNull();
    expect(parseTrustedProxyHops("")).toBeNull();
  });

  it("parses a valid non-negative integer", () => {
    expect(parseTrustedProxyHops("0")).toBe(0);
    expect(parseTrustedProxyHops("2")).toBe(2);
  });

  it("returns null for garbage input rather than a silent fallback", () => {
    expect(parseTrustedProxyHops("not-a-number")).toBeNull();
    expect(parseTrustedProxyHops("-1")).toBeNull();
    expect(parseTrustedProxyHops("1.5")).toBeNull();
  });
});

describe("extractClientIp — the XFF parser", () => {
  it("a single IP with hop count 1 returns that IP", () => {
    expect(extractClientIp("203.0.113.5", 1)).toBe("203.0.113.5");
  });

  it("hop count 1 takes the LAST entry, not the first — defeats a spoofed prefix", () => {
    // An attacker fully controls everything except what their own directly-
    // connected proxy appends. Trusting the first entry (the old, vulnerable
    // behavior) would let them mint an unlimited number of rate-limit buckets
    // just by prepending a fake IP to their own request.
    expect(extractClientIp("1.2.3.4, 203.0.113.5", 1)).toBe("203.0.113.5");
    expect(extractClientIp("1.2.3.4, 5.6.7.8, 203.0.113.5", 1)).toBe("203.0.113.5");
  });

  it("hop count 2 takes the second-from-right entry, for a two-proxy chain", () => {
    expect(extractClientIp("1.2.3.4, 203.0.113.5, 198.51.100.9", 2)).toBe("203.0.113.5");
  });

  it("hop count 0 ignores XFF entirely, even if present", () => {
    expect(extractClientIp("203.0.113.5", 0)).toBe("unknown");
  });

  it("drops malformed entries before counting hops from the end", () => {
    expect(extractClientIp("garbage, 203.0.113.5", 1)).toBe("203.0.113.5");
    expect(extractClientIp("203.0.113.5, not-an-ip", 1)).toBe("203.0.113.5");
  });

  it("supports IPv6 entries", () => {
    expect(extractClientIp("2001:db8::1", 1)).toBe("2001:db8::1");
    expect(extractClientIp("1.2.3.4, 2001:db8::1", 1)).toBe("2001:db8::1");
  });

  it("falls back to 'unknown' when the (cleaned) list is shorter than the hop count", () => {
    expect(extractClientIp("203.0.113.5", 2)).toBe("unknown");
    expect(extractClientIp("garbage, 203.0.113.5", 2)).toBe("unknown"); // only 1 valid entry survives cleaning
  });

  it("falls back to 'unknown' when the header is missing", () => {
    expect(extractClientIp(null, 1)).toBe("unknown");
  });

  it("falls back to 'unknown' when every entry is malformed", () => {
    expect(extractClientIp("not-an-ip, also-garbage", 1)).toBe("unknown");
  });
});

describe("getClientIp", () => {
  const ORIGINAL_ENV = process.env.TRUSTED_PROXY_HOPS;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = ORIGINAL_ENV;
  });

  it("fails SAFE to 'unknown' when TRUSTED_PROXY_HOPS is unset — no default, never trusts the header", () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.5" });
    expect(getClientIp(h)).toBe("unknown");
  });

  it("fails SAFE to 'unknown' when TRUSTED_PROXY_HOPS is garbage", () => {
    process.env.TRUSTED_PROXY_HOPS = "not-a-number";
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.5" });
    expect(getClientIp(h)).toBe("unknown");
  });

  it("uses hop count 1 when TRUSTED_PROXY_HOPS=1 — takes the last entry", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.5" });
    expect(getClientIp(h)).toBe("203.0.113.5");
  });

  // Milestone 11 staging verification (post-deploy review): the check that
  // actually matters isn't "does computedClientIp look like a plausible
  // public IP" — a caller-controlled prefix looks exactly as plausible as
  // a real one. What matters is that the SAME entry comes back whether or
  // not the caller prepends a bogus one. If a bogus prepended value ever
  // changed the result, TRUSTED_PROXY_HOPS would be wrong for the real
  // deployed topology and every quota in the app would be spoofable again
  // — this is the exact regression fix 1.1 exists to prevent, made
  // permanent rather than a one-off manual observation against staging.
  it("a request with a bogus x-forwarded-for prepended resolves to the SAME client IP as the clean request", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const clean = new Headers({ "x-forwarded-for": "203.0.113.5" });
    const withBogusPrefix = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.5" });
    expect(getClientIp(withBogusPrefix)).toBe(getClientIp(clean));
    expect(getClientIp(withBogusPrefix)).not.toBe("1.2.3.4"); // the attacker-supplied value must never win
  });

  it("a spoofed prefix cannot mint a fresh bucket at hop count 1", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const real = new Headers({ "x-forwarded-for": "203.0.113.5" });
    const spoofed1 = new Headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" });
    const spoofed2 = new Headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.5" });
    expect(getClientIp(real)).toBe(getClientIp(spoofed1));
    expect(getClientIp(spoofed1)).toBe(getClientIp(spoofed2));
  });

  it("respects a configured hop count from the environment", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.5, 198.51.100.9" });
    expect(getClientIp(h)).toBe("203.0.113.5");
  });

  it("never falls back to x-real-ip", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const h = new Headers({ "x-real-ip": "203.0.113.9" });
    expect(getClientIp(h)).toBe("unknown");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});
