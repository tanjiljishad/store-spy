import { describe, expect, it } from "vitest";
import { evaluateLoginThrottle } from "../login-policy";

describe("evaluateLoginThrottle", () => {
  it("allows with no delay under the delay threshold", () => {
    for (let n = 0; n < 5; n++) {
      expect(evaluateLoginThrottle({ emailFailuresInWindow: n, ipFailuresInWindow: 0 })).toEqual({
        outcome: "allow",
        delayMs: 0,
      });
    }
  });

  it("adds a progressive delay from 5 failures up to (but not including) the lock threshold", () => {
    const d5 = evaluateLoginThrottle({ emailFailuresInWindow: 5, ipFailuresInWindow: 0 });
    const d6 = evaluateLoginThrottle({ emailFailuresInWindow: 6, ipFailuresInWindow: 0 });
    const d9 = evaluateLoginThrottle({ emailFailuresInWindow: 9, ipFailuresInWindow: 0 });

    expect(d5.outcome).toBe("allow");
    expect(d6.outcome).toBe("allow");
    expect(d9.outcome).toBe("allow");
    if (d5.outcome !== "allow" || d6.outcome !== "allow" || d9.outcome !== "allow") throw new Error("unreachable");

    expect(d5.delayMs).toBeGreaterThan(0);
    // Strictly increasing — each additional failure makes the next attempt slower.
    expect(d6.delayMs).toBeGreaterThan(d5.delayMs);
    expect(d9.delayMs).toBeGreaterThan(d6.delayMs);
  });

  it("locks at exactly the email threshold (10) and beyond", () => {
    expect(evaluateLoginThrottle({ emailFailuresInWindow: 10, ipFailuresInWindow: 0 })).toEqual({ outcome: "locked" });
    expect(evaluateLoginThrottle({ emailFailuresInWindow: 25, ipFailuresInWindow: 0 })).toEqual({ outcome: "locked" });
  });

  it("locks at the looser per-IP threshold (30) even with zero email failures", () => {
    expect(evaluateLoginThrottle({ emailFailuresInWindow: 0, ipFailuresInWindow: 30 })).toEqual({ outcome: "locked" });
  });

  it("does not lock on IP failures alone below its own threshold", () => {
    const d = evaluateLoginThrottle({ emailFailuresInWindow: 0, ipFailuresInWindow: 29 });
    expect(d.outcome).toBe("allow");
  });

  it("the per-IP threshold is looser than the per-email one, on purpose", () => {
    // A shared NAT/office network hitting many different accounts must not
    // lock out the whole IP as easily as one account hitting its own limit.
    expect(evaluateLoginThrottle({ emailFailuresInWindow: 0, ipFailuresInWindow: 10 }).outcome).toBe("allow");
  });

  it("caps the progressive delay rather than growing unbounded", () => {
    const near = evaluateLoginThrottle({ emailFailuresInWindow: 9, ipFailuresInWindow: 0 });
    if (near.outcome !== "allow") throw new Error("unreachable");
    expect(near.delayMs).toBeLessThanOrEqual(8_000);
  });
});
