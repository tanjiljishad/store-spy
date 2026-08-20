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
    const hash = await hashPassword("supersecret1234");
    expect(hash).not.toContain("supersecret1234");
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same-input-value");
    const b = await hashPassword("same-input-value");
    expect(a).not.toBe(b);
  });
});

describe("isPasswordAcceptable — length", () => {
  it("rejects passwords under 10 characters", () => {
    expect(isPasswordAcceptable("short1")).toBe(false);
    expect(isPasswordAcceptable("nine12345")).toBe(false); // exactly 9
  });

  it("accepts a 10+ character password that clears every other rule", () => {
    expect(isPasswordAcceptable("correct-horse-battery-staple")).toBe(true);
  });

  it("rejects absurdly long input", () => {
    expect(isPasswordAcceptable("a1".repeat(150))).toBe(false);
  });
});

describe("isPasswordAcceptable — common-password blocklist", () => {
  it("rejects a base entry from the blocklist even at 10+ characters", () => {
    expect(isPasswordAcceptable("qwertyuiop")).toBe(false); // 10 chars, still a common one
  });

  it("rejects a common word with a common numeric suffix", () => {
    expect(isPasswordAcceptable("iloveyou123")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPasswordAcceptable("QwErTyUiOp")).toBe(false);
  });

  it("does not reject an unrelated long, uncommon password", () => {
    expect(isPasswordAcceptable("xk7#mQ2vLp9nR")).toBe(true);
  });
});

describe("isPasswordAcceptable — email local-part", () => {
  it("rejects a password containing the caller's own email local-part", () => {
    expect(isPasswordAcceptable("mycoolusername99", "mycoolusername@example.com")).toBe(false);
  });

  it("is case-insensitive against the local-part", () => {
    expect(isPasswordAcceptable("MyCoolUsername99", "mycoolusername@example.com")).toBe(false);
  });

  it("accepts a password unrelated to the email", () => {
    expect(isPasswordAcceptable("xk7#mQ2vLp9nR", "mycoolusername@example.com")).toBe(true);
  });

  it("ignores a very short local-part rather than rejecting on a coincidental substring", () => {
    // A 2-character local-part ("ab") would otherwise false-positive on
    // huge numbers of unrelated passwords that simply contain "ab".
    expect(isPasswordAcceptable("xk7#mQ2vLpab9nR", "ab@example.com")).toBe(true);
  });

  it("is optional — omitting email skips this check entirely", () => {
    expect(isPasswordAcceptable("mycoolusername99")).toBe(true);
  });
});
