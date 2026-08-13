import { describe, expect, it } from "vitest";
import {
  bestsellerDirectionFromMomentum,
  catalogDirectionFromSignals,
  deriveInterpretation,
} from "../interpretation";

describe("catalogDirectionFromSignals", () => {
  it("reads EXPANDING from a real CATALOG_EXPANSION signal", () => {
    expect(catalogDirectionFromSignals([{ kind: "CATALOG_EXPANSION" }])).toBe("EXPANDING");
  });

  it("reads CONTRACTING from a real CATALOG_CONTRACTION signal", () => {
    expect(catalogDirectionFromSignals([{ kind: "CATALOG_CONTRACTION" }])).toBe("CONTRACTING");
  });

  it("is null for STEADY — steady is not a direction", () => {
    expect(catalogDirectionFromSignals([{ kind: "STEADY" }])).toBeNull();
  });

  it("is null for PRICE_ACTIVITY alone — a price signal is not a catalog-size direction", () => {
    expect(catalogDirectionFromSignals([{ kind: "PRICE_ACTIVITY" }])).toBeNull();
  });

  it("is null for no signals at all (e.g. insufficient history)", () => {
    expect(catalogDirectionFromSignals([])).toBeNull();
  });
});

describe("bestsellerDirectionFromMomentum", () => {
  it("is null with fewer than 2 decided (non-null) momentum values", () => {
    expect(bestsellerDirectionFromMomentum([])).toBeNull();
    expect(bestsellerDirectionFromMomentum([null, null])).toBeNull();
    expect(bestsellerDirectionFromMomentum(["IMPROVING"])).toBeNull();
  });

  it("requires a strict majority, not just a plurality — one improving among four decided is not enough", () => {
    expect(bestsellerDirectionFromMomentum(["IMPROVING", "STABLE", "STABLE", "STABLE"])).toBeNull();
  });

  it("reports IMPROVING when a genuine majority improved", () => {
    expect(bestsellerDirectionFromMomentum(["IMPROVING", "IMPROVING", "STABLE"])).toBe("IMPROVING");
  });

  it("reports DECLINING when a genuine majority declined", () => {
    expect(bestsellerDirectionFromMomentum(["DECLINING", "DECLINING", "IMPROVING"])).toBe("DECLINING");
  });

  it("is null on an exact tie between improving and declining", () => {
    expect(bestsellerDirectionFromMomentum(["IMPROVING", "DECLINING"])).toBeNull();
  });

  it("ignores nulls when computing the majority (only counts products with real momentum)", () => {
    expect(bestsellerDirectionFromMomentum([null, null, "IMPROVING", "IMPROVING", "STABLE"])).toBe("IMPROVING");
  });
});

describe("deriveInterpretation", () => {
  it("returns null when neither signal is available — no evidence, no claim", () => {
    expect(deriveInterpretation(null, null)).toBeNull();
  });

  it("returns null when only catalog direction is available — one signal is not enough to combine", () => {
    expect(deriveInterpretation("EXPANDING", null)).toBeNull();
  });

  it("returns null when only bestseller direction is available", () => {
    expect(deriveInterpretation(null, "IMPROVING")).toBeNull();
  });

  it("returns null when the two signals disagree (expanding catalog, declining rank)", () => {
    expect(deriveInterpretation("EXPANDING", "DECLINING")).toBeNull();
  });

  it("returns null when the two signals disagree (contracting catalog, improving rank)", () => {
    expect(deriveInterpretation("CONTRACTING", "IMPROVING")).toBeNull();
  });

  it("combines EXPANDING + IMPROVING into a conservative, non-sales headline", () => {
    const result = deriveInterpretation("EXPANDING", "IMPROVING");
    expect(result).not.toBeNull();
    expect(result!.headline).toBe("Storefront activity increasing");
    expect(result!.detail).not.toMatch(/sales (increased|grew|rose)|revenue (increased|grew|rose)/i);
    expect(result!.detail).toMatch(/not confirmation of sales or revenue growth/i);
  });

  it("combines CONTRACTING + DECLINING into a conservative, non-sales headline", () => {
    const result = deriveInterpretation("CONTRACTING", "DECLINING");
    expect(result).not.toBeNull();
    expect(result!.headline).toBe("Storefront activity decreasing");
    expect(result!.detail).toMatch(/not confirmation of reduced sales or revenue/i);
  });

  it("never produces the word 'sales' in either headline", () => {
    const up = deriveInterpretation("EXPANDING", "IMPROVING")!;
    const down = deriveInterpretation("CONTRACTING", "DECLINING")!;
    expect(up.headline.toLowerCase()).not.toContain("sales");
    expect(down.headline.toLowerCase()).not.toContain("sales");
  });
});
