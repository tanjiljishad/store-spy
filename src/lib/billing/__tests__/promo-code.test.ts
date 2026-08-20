import { describe, expect, it } from "vitest";
import { generatePromoCode, isValidVanityCode, normalizePromoCode } from "../promo-code";

describe("generatePromoCode", () => {
  it("produces a 12-character code", () => {
    expect(generatePromoCode()).toHaveLength(12);
  });

  it("uses only Crockford base32 characters — never I, L, O, or U", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePromoCode();
      expect(code).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{12}$/);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it("is not deterministic — two calls produce different codes", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generatePromoCode()));
    expect(codes.size).toBe(100); // no collisions in 100 draws from a 60-bit space
  });
});

describe("normalizePromoCode", () => {
  it("uppercases", () => {
    expect(normalizePromoCode("launch50")).toBe("LAUNCH50");
  });

  it("strips whitespace and dashes", () => {
    expect(normalizePromoCode("abc-def")).toBe("ABCDEF");
    expect(normalizePromoCode("  abc def  ")).toBe("ABCDEF");
  });

  it("abc-def and ABCDEF normalize to the same value", () => {
    expect(normalizePromoCode("abc-def")).toBe(normalizePromoCode("ABCDEF"));
  });
});

describe("isValidVanityCode", () => {
  it("accepts a plausible vanity code", () => {
    expect(isValidVanityCode("LAUNCH50")).toBe(true);
  });

  it("rejects too short", () => {
    expect(isValidVanityCode("AB")).toBe(false);
  });

  it("rejects too long", () => {
    expect(isValidVanityCode("A".repeat(33))).toBe(false);
  });

  it("rejects lowercase (must be pre-normalized)", () => {
    expect(isValidVanityCode("launch50")).toBe(false);
  });

  it("rejects non-alphanumeric characters", () => {
    expect(isValidVanityCode("LAUNCH-50")).toBe(false);
    expect(isValidVanityCode("LAUNCH!50")).toBe(false);
  });
});
