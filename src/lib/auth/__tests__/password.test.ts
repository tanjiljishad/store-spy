import { describe, expect, it } from "vitest";
import { hashPassword, isPasswordAcceptable, verifyPassword } from "../password";

describe("hashPassword / verifyPassword", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("never stores the plaintext in the hash", async () => {
    const hash = await hashPassword("supersecret");
    expect(hash).not.toContain("supersecret");
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    expect(a).not.toBe(b);
  });
});

describe("isPasswordAcceptable", () => {
  it("rejects passwords under 8 characters", () => {
    expect(isPasswordAcceptable("short1")).toBe(false);
  });

  it("accepts an 8+ character password", () => {
    expect(isPasswordAcceptable("longenough")).toBe(true);
  });

  it("rejects absurdly long input", () => {
    expect(isPasswordAcceptable("a".repeat(300))).toBe(false);
  });
});
