import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateUnsubscribeToken, verifyUnsubscribeToken } from "../unsubscribe-token";

describe("unsubscribe token", () => {
  const originalSecret = process.env.UNSUBSCRIBE_TOKEN_SECRET;

  beforeEach(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "test-secret-do-not-use-in-real-env";
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    else process.env.UNSUBSCRIBE_TOKEN_SECRET = originalSecret;
  });

  it("a generated token verifies for the same user id", () => {
    const token = generateUnsubscribeToken("user-1");
    expect(token).not.toBeNull();
    expect(verifyUnsubscribeToken("user-1", token)).toBe(true);
  });

  it("a token generated for one user does not verify for another", () => {
    const token = generateUnsubscribeToken("user-1");
    expect(verifyUnsubscribeToken("user-2", token)).toBe(false);
  });

  it("is deterministic — the same user id always produces the same token under the same secret", () => {
    expect(generateUnsubscribeToken("user-1")).toBe(generateUnsubscribeToken("user-1"));
  });

  it("a token minted under one secret does not verify under a different secret", () => {
    const token = generateUnsubscribeToken("user-1");
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "a-different-secret";
    expect(verifyUnsubscribeToken("user-1", token)).toBe(false);
  });

  it("fails closed when UNSUBSCRIBE_TOKEN_SECRET is unset — generation returns null, verification rejects everything", () => {
    const token = generateUnsubscribeToken("user-1");
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    expect(generateUnsubscribeToken("user-1")).toBeNull();
    expect(verifyUnsubscribeToken("user-1", token)).toBe(false);
  });

  it("rejects a missing or garbage token", () => {
    expect(verifyUnsubscribeToken("user-1", null)).toBe(false);
    expect(verifyUnsubscribeToken("user-1", undefined)).toBe(false);
    expect(verifyUnsubscribeToken("user-1", "not-a-real-token")).toBe(false);
  });
});
