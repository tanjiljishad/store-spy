import { describe, expect, it } from "vitest";
import { listPriceCents } from "../pricing";

describe("listPriceCents", () => {
  it("FREE is always 0, regardless of period", () => {
    expect(listPriceCents("FREE", "MONTHLY")).toBe(0);
    expect(listPriceCents("FREE", "ANNUAL")).toBe(0);
  });

  it("BASIC and BUSINESS are priced identically — one paid tier, two retained enum values", () => {
    expect(listPriceCents("BASIC", "MONTHLY")).toBe(listPriceCents("BUSINESS", "MONTHLY"));
    expect(listPriceCents("BASIC", "ANNUAL")).toBe(listPriceCents("BUSINESS", "ANNUAL"));
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
