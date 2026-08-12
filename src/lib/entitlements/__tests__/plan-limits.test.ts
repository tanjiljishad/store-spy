import { describe, expect, it } from "vitest";
import { getPlanLimits, isUnderLimit } from "../plan-limits";
import { hasCapability, maxActiveMonitoredStores, maxUniqueAnalyses, monitoringDurationDays } from "../entitlement-service";

describe("getPlanLimits", () => {
  it("FREE matches the spec exactly: 3 analyses, 1 monitored store, 30 days", () => {
    const limits = getPlanLimits("FREE");
    expect(limits.maxUniqueAnalyses).toBe(3);
    expect(limits.maxActiveMonitoredStores).toBe(1);
    expect(limits.monitoringDurationDays).toBe(30);
  });

  it("FREE gets full historical access but not advanced intelligence", () => {
    const limits = getPlanLimits("FREE");
    expect(limits.historicalAccess).toBe(true);
    expect(limits.advancedIntelligence).toBe(false);
  });

  it("BASIC represents unlimited analyses and continuous monitoring as null, never a large integer", () => {
    const limits = getPlanLimits("BASIC");
    expect(limits.maxUniqueAnalyses).toBeNull();
    expect(limits.monitoringDurationDays).toBeNull();
    expect(limits.maxActiveMonitoredStores).toBe(20);
  });
});

describe("entitlement-service typed getters", () => {
  it("read from the same table as getPlanLimits — no separate source of truth", () => {
    expect(maxUniqueAnalyses("FREE")).toBe(3);
    expect(maxActiveMonitoredStores("FREE")).toBe(1);
    expect(monitoringDurationDays("FREE")).toBe(30);
  });

  it("hasCapability reflects plan-limits for boolean capabilities", () => {
    expect(hasCapability("FREE", "HISTORICAL_ACCESS")).toBe(true);
    expect(hasCapability("FREE", "ADVANCED_INTELLIGENCE")).toBe(false);
    expect(hasCapability("BASIC", "ADVANCED_INTELLIGENCE")).toBe(true);
  });

  it("BASIC's typed getters surface null, not a sentinel number", () => {
    expect(maxUniqueAnalyses("BASIC")).toBeNull();
    expect(monitoringDurationDays("BASIC")).toBeNull();
    expect(maxActiveMonitoredStores("BASIC")).toBe(20);
  });
});

describe("isUnderLimit", () => {
  it("null means unlimited — always under, no matter the count", () => {
    expect(isUnderLimit(0, null)).toBe(true);
    expect(isUnderLimit(1_000_000, null)).toBe(true);
  });

  it("enforces a real numeric bound", () => {
    expect(isUnderLimit(2, 3)).toBe(true);
    expect(isUnderLimit(3, 3)).toBe(false);
    expect(isUnderLimit(4, 3)).toBe(false);
  });
});
