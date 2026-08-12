import { describe, expect, it } from "vitest";
import { daysRemaining } from "../days-remaining";

describe("daysRemaining", () => {
  const now = new Date("2026-08-11T12:00:00Z");

  it("returns the full count for a date 30 days out", () => {
    expect(daysRemaining(new Date("2026-09-10T12:00:00Z"), now)).toBe(30);
  });

  it("rounds up a partial day", () => {
    expect(daysRemaining(new Date("2026-08-12T00:00:00Z"), now)).toBe(1);
  });

  it("never returns negative — clamps to 0 once past expiry", () => {
    expect(daysRemaining(new Date("2026-08-01T00:00:00Z"), now)).toBe(0);
  });

  it("returns 0 for the exact expiry instant", () => {
    expect(daysRemaining(now, now)).toBe(0);
  });
});
