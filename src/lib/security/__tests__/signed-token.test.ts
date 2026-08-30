import { describe, expect, it } from "vitest";
import { SIGNED_TOKEN_CLOCK_SKEW_MS, createSignedToken, verifySignedToken } from "../signed-token";

const SECRET = "test-signing-secret";
const HOUR = 60 * 60 * 1000;

describe("signed-token (audit fix M-4)", () => {
  it("round-trips within the max age", () => {
    const t0 = 1_700_000_000_000;
    const token = createSignedToken(SECRET, "payload-a", t0);
    expect(verifySignedToken(SECRET, "payload-a", token, 24 * HOUR, t0)).toBe(true);
    expect(verifySignedToken(SECRET, "payload-a", token, 24 * HOUR, t0 + 24 * HOUR - 1)).toBe(true);
  });

  it("rejects once older than the max age", () => {
    const t0 = 1_700_000_000_000;
    const token = createSignedToken(SECRET, "payload-a", t0);
    expect(verifySignedToken(SECRET, "payload-a", token, 24 * HOUR, t0 + 24 * HOUR + 1)).toBe(false);
  });

  it("tolerates small negative clock skew but not a far-future issued-at", () => {
    const t0 = 1_700_000_000_000;
    const token = createSignedToken(SECRET, "p", t0);
    expect(verifySignedToken(SECRET, "p", token, HOUR, t0 - SIGNED_TOKEN_CLOCK_SKEW_MS + 1)).toBe(true);
    expect(verifySignedToken(SECRET, "p", token, HOUR, t0 - SIGNED_TOKEN_CLOCK_SKEW_MS - 5_000)).toBe(false);
  });

  it("rejects a different payload, a different secret, and a tampered timestamp", () => {
    const t0 = 1_700_000_000_000;
    const token = createSignedToken(SECRET, "payload-a", t0);
    expect(verifySignedToken(SECRET, "payload-b", token, 24 * HOUR, t0)).toBe(false);
    expect(verifySignedToken("other-secret", "payload-a", token, 24 * HOUR, t0)).toBe(false);

    const [v, , mac] = token.split(".");
    expect(verifySignedToken(SECRET, "payload-a", `${v}.${t0 + 999 * HOUR}.${mac}`, 24 * HOUR, t0)).toBe(false);
  });

  it("rejects malformed shapes: wrong part count, wrong version, non-numeric or oversized timestamp, empty/nullish", () => {
    expect(verifySignedToken(SECRET, "p", "", HOUR)).toBe(false);
    expect(verifySignedToken(SECRET, "p", null, HOUR)).toBe(false);
    expect(verifySignedToken(SECRET, "p", "deadbeef".repeat(8), HOUR)).toBe(false); // legacy bare hex
    expect(verifySignedToken(SECRET, "p", "v1.123", HOUR)).toBe(false);
    expect(verifySignedToken(SECRET, "p", "v2.123.abc", HOUR)).toBe(false);
    expect(verifySignedToken(SECRET, "p", "v1.notanum.abc", HOUR)).toBe(false);
    expect(verifySignedToken(SECRET, "p", `v1.${"9".repeat(20)}.abc`, HOUR)).toBe(false);
  });
});
