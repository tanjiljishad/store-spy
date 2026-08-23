import { describe, expect, it } from "vitest";
import { listPriceCents } from "../pricing";

describe("listPriceCents", () => {
  it("FREE is always 0, regardless of period", () => {
    expect(listPriceCents("FREE", "MONTHLY")).toBe(0);
    expect(listPriceCents("FREE", "ANNUAL")).toBe(0);
  });

  it("Milestone 12 D4: BASIC ($19/mo placeholder) and BUSINESS ($49/mo, confirmed) are no longer priced identically", () => {
    expect(listPriceCents("BASIC", "MONTHLY")).toBe(1900);
    expect(listPriceCents("BUSINESS", "MONTHLY")).toBe(4900);
    expect(listPriceCents("BASIC", "MONTHLY")).not.toBe(listPriceCents("BUSINESS", "MONTHLY"));
  });

  it("returns integer cents, never a float-shaped value", () => {
    for (const plan of ["FREE", "BASIC", "BUSINESS"] as const) {
      for (const period of ["MONTHLY", "ANNUAL"] as const) {
        expect(Number.isInteger(listPriceCents(plan, period))).toBe(true);
      }
    }
  });

  it("ANNUAL is exactly 12x MONTHLY (no discount applied — see the module's own doc comment)", () => {
    expect(listPriceCents("BASIC", "ANNUAL")).toBe(listPriceCents("BASIC", "MONTHLY") * 12);
  });
});
