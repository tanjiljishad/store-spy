import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../constant-time-equal";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("a-real-secret-value", "a-real-secret-value")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("a-real-secret-value", "a-fake-secret-value")).toBe(false);
  });

  it("returns false for different lengths, without throwing", () => {
    expect(constantTimeEqual("short", "a-much-longer-string")).toBe(false);
  });

  it("returns false against an empty string", () => {
    expect(constantTimeEqual("", "non-empty")).toBe(false);
  });

  it("two empty strings are equal", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
