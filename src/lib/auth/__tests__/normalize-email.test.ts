import { describe, expect, it } from "vitest";
import { isPlausibleEmail, normalizeEmail } from "../normalize-email";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
  });

  it("makes 'Foo@Example.com' and 'foo@example.com' identical", () => {
    expect(normalizeEmail("Foo@Example.com")).toBe(normalizeEmail("foo@example.com"));
  });
});

describe("isPlausibleEmail", () => {
  it("accepts a normal address", () => {
    expect(isPlausibleEmail("foo@example.com")).toBe(true);
  });

  it("rejects missing @", () => {
    expect(isPlausibleEmail("not-an-email")).toBe(false);
  });

  it("rejects missing domain", () => {
    expect(isPlausibleEmail("foo@")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isPlausibleEmail("")).toBe(false);
  });
});
