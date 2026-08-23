import { describe, expect, it } from "vitest";
import { containsEmailShapedValue } from "../audit-pii";

describe("containsEmailShapedValue", () => {
  it("detects a top-level email-shaped string", () => {
    expect(containsEmailShapedValue("person@example.com")).toBe(true);
  });

  it("detects an email nested one level deep in an object", () => {
    expect(containsEmailShapedValue({ userEmail: "person@example.com" })).toBe(true);
  });

  it("detects an email nested inside a nested object (e.g. filters.emailQuery)", () => {
    expect(containsEmailShapedValue({ filters: { emailQuery: "person@example.com", plan: "BASIC" } })).toBe(true);
  });

  it("detects an email inside an array", () => {
    expect(containsEmailShapedValue({ recipients: ["a@example.com", "b@example.com"] })).toBe(true);
  });

  it("detects an email inside an array of objects", () => {
    expect(containsEmailShapedValue([{ id: "u1" }, { email: "person@example.com" }])).toBe(true);
  });

  it("is false for ordinary, non-email metadata shapes actually used in this codebase", () => {
    expect(containsEmailShapedValue({ fromPlan: "FREE", toPlan: "BASIC" })).toBe(false);
    expect(containsEmailShapedValue({ subscriptionId: "sub_123", watchesExpired: 2 })).toBe(false);
    expect(containsEmailShapedValue({ codeLast4: "ABCD", discountType: "PERCENT" })).toBe(false);
    expect(containsEmailShapedValue({ filters: { plan: "BUSINESS", hasEmailFilter: true }, rowCount: 5 })).toBe(false);
  });

  it("is false for null, undefined, numbers, and booleans", () => {
    expect(containsEmailShapedValue(null)).toBe(false);
    expect(containsEmailShapedValue(undefined)).toBe(false);
    expect(containsEmailShapedValue(42)).toBe(false);
    expect(containsEmailShapedValue(true)).toBe(false);
  });

  it("is false for a plain non-email string, even one containing '@'", () => {
    expect(containsEmailShapedValue("system:expiry")).toBe(false);
    expect(containsEmailShapedValue("@handle-not-an-email")).toBe(false);
  });
});
