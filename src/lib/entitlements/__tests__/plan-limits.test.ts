import { describe, expect, it } from "vitest";
import { getPlanLimits, isUnderLimit } from "../plan-limits";
import { hasCapability, maxActiveMonitoredStores, maxUniqueAnalyses, monitoringDurationDays } from "../entitlement-service";

describe("getPlanLimits", () => {
  it("FREE has unlimited analysis, one monitor, and no commercial expiration", () => {
    const limits = getPlanLimits("FREE");
    expect(limits.maxUniqueAnalyses).toBeNull();
    expect(limits.maxActiveMonitoredStores).toBe(1);
    expect(limits.monitoringDurationDays).toBeNull();
  });

  it("retained BASIC and BUSINESS values map to the single paid entitlement", () => {
    for (const plan of ["BASIC", "BUSINESS"] as const) {
      const limits = getPlanLimits(plan);
      expect(limits.maxUniqueAnalyses).toBeNull();
      expect(limits.maxActiveMonitoredStores).toBe(10);
      expect(limits.monitoringDurationDays).toBeNull();
    }
  });
});

describe("entitlement-service typed getters", () => {
  it("reads the same source of truth for FREE", () => {
    expect(maxUniqueAnalyses("FREE")).toBeNull();
    expect(maxActiveMonitoredStores("FREE")).toBe(1);
    expect(monitoringDurationDays("FREE")).toBeNull();
  });

  it("keeps existing boolean capability mapping intact", () => {
    expect(hasCapability("FREE", "HISTORICAL_ACCESS")).toBe(true);
    expect(hasCapability("FREE", "ADVANCED_INTELLIGENCE")).toBe(false);
    expect(hasCapability("BASIC", "ADVANCED_INTELLIGENCE")).toBe(true);
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
