import { describe, expect, it } from "vitest";
import { limitReached, nextPlanUp } from "../limit-reached";

describe("nextPlanUp", () => {
  it("FREE upgrades to BASIC", () => expect(nextPlanUp("FREE")).toBe("BASIC"));
  it("BASIC upgrades to BUSINESS", () => expect(nextPlanUp("BASIC")).toBe("BUSINESS"));
  it("BUSINESS has nowhere higher — stays BUSINESS, the least-wrong answer the shape allows", () =>
    expect(nextPlanUp("BUSINESS")).toBe("BUSINESS"));
});

describe("limitReached — Milestone 12 §1.5's shared response envelope", () => {
  it("builds the full shape with resetsAt when supplied", () => {
    const resetsAt = new Date("2026-08-21T00:00:00.000Z");
    expect(limitReached({ limit: "ANALYSES_PER_DAY", current: 10, max: 10, resetsAt, plan: "FREE" })).toEqual({
      code: "LIMIT_REACHED",
      limit: "ANALYSES_PER_DAY",
      current: 10,
      max: 10,
      resetsAt: "2026-08-21T00:00:00.000Z",
      upgradeTo: "BASIC",
    });
  });

  it("omits resetsAt entirely (not null) when not supplied — matches the optional field in the API shape", () => {
    const result = limitReached({ limit: "MONITORED_STORES", current: 20, max: 20, plan: "BASIC" });
    expect(result).toEqual({ code: "LIMIT_REACHED", limit: "MONITORED_STORES", current: 20, max: 20, upgradeTo: "BUSINESS" });
    expect("resetsAt" in result).toBe(false);
  });

  it("omits resetsAt when explicitly null too", () => {
    const result = limitReached({ limit: "TRIAL_EXPIRED", current: 0, max: 0, resetsAt: null, plan: "FREE" });
    expect("resetsAt" in result).toBe(false);
  });

  it("upgradeTo tracks the caller's plan", () => {
    expect(limitReached({ limit: "ANALYSES_PER_DAY", current: 100, max: 100, plan: "BUSINESS" }).upgradeTo).toBe("BUSINESS");
  });
});
