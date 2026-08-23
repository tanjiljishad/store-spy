import { describe, expect, it } from "vitest";
import { ANONYMOUS_ANALYSES_PER_24H, getPlanLimits, isUnderLimit } from "../plan-limits";
import { freeTrialDays, hasCapability, maxActiveMonitoredStores, maxAnalysesPer24h, monitoringDurationDays } from "../entitlement-service";

/**
 * Milestone 12 §1.1 acceptance criterion: "The plan matrix in 1.1 is
 * asserted against a literal table in a unit test, every cell." The table
 * below is transcribed directly from the milestone doc's §1.1 table —
 * every other test in this suite should be reading the SAME constants this
 * one pins, never a second hand-copied set of numbers.
 */
describe("plan-limits — Milestone 12 §1.1 matrix, every cell", () => {
  it("FREE", () => {
    expect(getPlanLimits("FREE")).toEqual({
      maxAnalysesPer24h: 10,
      maxActiveMonitoredStores: 1,
      monitoringDurationDays: null, // "30 days from signup" is expressed via freeTrialDays + User.freeTrialEndsAt, not this field
      freeTrialDays: 30,
      historicalAccess: true,
      advancedIntelligence: false,
    });
  });

  it("BASIC", () => {
    expect(getPlanLimits("BASIC")).toEqual({
      maxAnalysesPer24h: 50,
      maxActiveMonitoredStores: 20,
      monitoringDurationDays: null, // continuous
      freeTrialDays: null,
      historicalAccess: true,
      advancedIntelligence: true,
    });
  });

  it("BUSINESS", () => {
    expect(getPlanLimits("BUSINESS")).toEqual({
      maxAnalysesPer24h: 100,
      maxActiveMonitoredStores: 50,
      monitoringDurationDays: null, // continuous
      freeTrialDays: null,
      historicalAccess: true,
      advancedIntelligence: true,
    });
  });

  it("anonymous is 3/24h — not a PlanTier, kept as its own constant", () => {
    expect(ANONYMOUS_ANALYSES_PER_24H).toBe(3);
  });
});

describe("entitlement-service typed getters read the same source of truth", () => {
  it("maxAnalysesPer24h", () => {
    expect(maxAnalysesPer24h("FREE")).toBe(10);
    expect(maxAnalysesPer24h("BASIC")).toBe(50);
    expect(maxAnalysesPer24h("BUSINESS")).toBe(100);
  });

  it("maxActiveMonitoredStores", () => {
    expect(maxActiveMonitoredStores("FREE")).toBe(1);
    expect(maxActiveMonitoredStores("BASIC")).toBe(20);
    expect(maxActiveMonitoredStores("BUSINESS")).toBe(50);
  });

  it("monitoringDurationDays — continuous (null) for every plan today", () => {
    expect(monitoringDurationDays("FREE")).toBeNull();
    expect(monitoringDurationDays("BASIC")).toBeNull();
    expect(monitoringDurationDays("BUSINESS")).toBeNull();
  });

  it("freeTrialDays — only FREE carries a trial ceiling", () => {
    expect(freeTrialDays("FREE")).toBe(30);
    expect(freeTrialDays("BASIC")).toBeNull();
    expect(freeTrialDays("BUSINESS")).toBeNull();
  });

  it("keeps existing boolean capability mapping intact", () => {
    expect(hasCapability("FREE", "HISTORICAL_ACCESS")).toBe(true);
    expect(hasCapability("FREE", "ADVANCED_INTELLIGENCE")).toBe(false);
    expect(hasCapability("BASIC", "ADVANCED_INTELLIGENCE")).toBe(true);
    expect(hasCapability("BUSINESS", "ADVANCED_INTELLIGENCE")).toBe(true);
  });
});

describe("isUnderLimit", () => {
  it("null means unlimited", () => {
    expect(isUnderLimit(0, null)).toBe(true);
    expect(isUnderLimit(1_000_000, null)).toBe(true);
  });

  it("enforces a numeric bound", () => {
    expect(isUnderLimit(0, 1)).toBe(true);
    expect(isUnderLimit(1, 1)).toBe(false);
  });
});
