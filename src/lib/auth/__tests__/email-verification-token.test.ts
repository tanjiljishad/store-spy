import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS,
  generateEmailVerificationToken,
  verifyEmailVerificationToken,
} from "../email-verification-token";

describe("email verification token", () => {
  const originalSecret = process.env.EMAIL_VERIFICATION_TOKEN_SECRET;

  beforeEach(() => {
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET = "test-secret-do-not-use-in-real-env";
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
    else process.env.EMAIL_VERIFICATION_TOKEN_SECRET = originalSecret;
  });

  it("a generated token verifies for the same user id and email", () => {
    const token = generateEmailVerificationToken("user-1", "a@example.com");
    expect(token).not.toBeNull();
    expect(verifyEmailVerificationToken("user-1", "a@example.com", token)).toBe(true);
  });

  it("a token generated for one user does not verify for another", () => {
    const token = generateEmailVerificationToken("user-1", "a@example.com");
    expect(verifyEmailVerificationToken("user-2", "a@example.com", token)).toBe(false);
  });

  it("a token stops verifying once the bound email changes — the whole reason this is bound to email, not just user id", () => {
    const token = generateEmailVerificationToken("user-1", "old@example.com");
    expect(verifyEmailVerificationToken("user-1", "new@example.com", token)).toBe(false);
  });

  // Audit fix M-4: no longer a bare deterministic HMAC — the token carries a
  // signed issued-at time, so it is time-bounded and two mints differ.
  it("is time-bounded — verifies inside the TTL, rejects once it has lapsed", () => {
    const t0 = 1_700_000_000_000;
    const token = generateEmailVerificationToken("user-1", "a@example.com", t0)!;

    expect(verifyEmailVerificationToken("user-1", "a@example.com", token, t0)).toBe(true);
    expect(verifyEmailVerificationToken("user-1", "a@example.com", token, t0 + EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS - 1)).toBe(true);
    expect(verifyEmailVerificationToken("user-1", "a@example.com", token, t0 + EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS + 1_000)).toBe(false);
  });

  it("rejects a token whose issued-at timestamp has been tampered to extend its life", () => {
    const t0 = 1_700_000_000_000;
    const token = generateEmailVerificationToken("user-1", "a@example.com", t0)!;
    const [v, , mac] = token.split(".");
    const forged = `${v}.${t0 + EMAIL_VERIFICATION_TOKEN_MAX_AGE_MS * 10}.${mac}`;
    expect(verifyEmailVerificationToken("user-1", "a@example.com", forged, t0)).toBe(false);
  });

  it("rejects a legacy bare-hex token shape outright", () => {
    expect(verifyEmailVerificationToken("user-1", "a@example.com", "a".repeat(64))).toBe(false);
  });

  it("a token minted under one secret does not verify under a different secret", () => {
    const token = generateEmailVerificationToken("user-1", "a@example.com");
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET = "a-different-secret";
    expect(verifyEmailVerificationToken("user-1", "a@example.com", token)).toBe(false);
  });

  it("fails closed when EMAIL_VERIFICATION_TOKEN_SECRET is unset — generation returns null, verification rejects everything", () => {
    const token = generateEmailVerificationToken("user-1", "a@example.com");
    delete process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
    expect(generateEmailVerificationToken("user-1", "a@example.com")).toBeNull();
    expect(verifyEmailVerificationToken("user-1", "a@example.com", token)).toBe(false);
  });

  it("rejects a missing or garbage token", () => {
    expect(verifyEmailVerificationToken("user-1", "a@example.com", null)).toBe(false);
    expect(verifyEmailVerificationToken("user-1", "a@example.com", undefined)).toBe(false);
    expect(verifyEmailVerificationToken("user-1", "a@example.com", "not-a-real-token")).toBe(false);
  });
});
