import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRateLimitState, checkRateLimit, getClientIp } from "../rate-limit";

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

describe("getClientIp", () => {
  it("prefers the first x-forwarded-for entry", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(getClientIp(h)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "203.0.113.9" });
    expect(getClientIp(h)).toBe("203.0.113.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});
