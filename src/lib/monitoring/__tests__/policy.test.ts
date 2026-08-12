import { describe, expect, it } from "vitest";
import {
  MAX_CONSECUTIVE_FAILURES,
  isMonitorable,
  nextCrawlAfterFailure,
  nextCrawlAfterSuccess,
  shouldDemoteToDisabled,
} from "../policy";

const NOW = new Date("2026-08-11T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("nextCrawlAfterSuccess", () => {
  it("schedules each tier at its documented cadence", () => {
    expect(nextCrawlAfterSuccess("HOT", NOW)!.getTime() - NOW.getTime()).toBe(8 * HOUR);
    expect(nextCrawlAfterSuccess("WARM", NOW)!.getTime() - NOW.getTime()).toBe(1 * DAY);
    expect(nextCrawlAfterSuccess("COOL", NOW)!.getTime() - NOW.getTime()).toBe(7 * DAY);
    expect(nextCrawlAfterSuccess("COLD", NOW)!.getTime() - NOW.getTime()).toBe(30 * DAY);
    expect(nextCrawlAfterSuccess("DORMANT", NOW)!.getTime() - NOW.getTime()).toBe(90 * DAY);
  });

  it("never schedules a DISABLED store", () => {
    expect(nextCrawlAfterSuccess("DISABLED", NOW)).toBeNull();
  });

  it("faster tiers are always sooner than slower ones", () => {
    const tiers = ["HOT", "WARM", "COOL", "COLD", "DORMANT"] as const;
    const times = tiers.map((t) => nextCrawlAfterSuccess(t, NOW)!.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });
});

describe("nextCrawlAfterFailure", () => {
  it("backs off exponentially with each consecutive failure", () => {
    const delay = (streak: number) => nextCrawlAfterFailure(streak, NOW).getTime() - NOW.getTime();
    expect(delay(1)).toBe(1 * HOUR);
    expect(delay(2)).toBe(2 * HOUR);
    expect(delay(3)).toBe(4 * HOUR);
    expect(delay(4)).toBe(8 * HOUR);
  });

  it("caps at 48h so a long-failing store doesn't drift to absurd delays", () => {
    const delay = (streak: number) => nextCrawlAfterFailure(streak, NOW).getTime() - NOW.getTime();
    expect(delay(10)).toBe(48 * HOUR);
    expect(delay(100)).toBe(48 * HOUR);
  });
});

describe("shouldDemoteToDisabled / MAX_CONSECUTIVE_FAILURES", () => {
  it("does not demote below the threshold", () => {
    expect(shouldDemoteToDisabled(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false);
  });

  it("demotes at and beyond the threshold", () => {
    expect(shouldDemoteToDisabled(MAX_CONSECUTIVE_FAILURES)).toBe(true);
    expect(shouldDemoteToDisabled(MAX_CONSECUTIVE_FAILURES + 5)).toBe(true);
  });
});

describe("isMonitorable", () => {
  it("is true for every tier except DISABLED", () => {
    for (const tier of ["HOT", "WARM", "COOL", "COLD", "DORMANT"] as const) {
      expect(isMonitorable(tier)).toBe(true);
    }
    expect(isMonitorable("DISABLED")).toBe(false);
  });
});
