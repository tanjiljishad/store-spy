import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVerificationUrl } from "../verification-email";

/**
 * Audit fix M-2: the confirmation link's origin comes from APP_URL, never
 * the incoming request's Host header. These tests lock that in — there is
 * no request in scope here at all, which is the point.
 */
describe("buildVerificationUrl", () => {
  const origApp = process.env.APP_URL;
  const origSecret = process.env.EMAIL_VERIFICATION_TOKEN_SECRET;

  beforeEach(() => {
    process.env.APP_URL = "https://storespy.example";
    process.env.EMAIL_VERIFICATION_TOKEN_SECRET = "test-secret-do-not-use-in-real-env";
  });
  afterEach(() => {
    if (origApp === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = origApp;
    if (origSecret === undefined) delete process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
    else process.env.EMAIL_VERIFICATION_TOKEN_SECRET = origSecret;
  });

  it("builds the link against APP_URL's origin, with uid and token query params", () => {
    const url = buildVerificationUrl("user-1", "a@example.com");
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe("https://storespy.example");
    expect(parsed.pathname).toBe("/verify-email");
    expect(parsed.searchParams.get("uid")).toBe("user-1");
    expect(parsed.searchParams.get("token")).toBeTruthy();
  });

  it("uses only the origin of APP_URL — any path/query/fragment on APP_URL is discarded", () => {
    process.env.APP_URL = "https://storespy.example/some/path?x=1#frag";
    const parsed = new URL(buildVerificationUrl("user-1", "a@example.com") as string);
    expect(parsed.origin).toBe("https://storespy.example");
    expect(parsed.pathname).toBe("/verify-email");
  });

  it("fails closed to null when APP_URL is unset", () => {
    delete process.env.APP_URL;
    expect(buildVerificationUrl("user-1", "a@example.com")).toBeNull();
  });

  it("fails closed to null when APP_URL is not a valid http(s) URL", () => {
    process.env.APP_URL = "not-a-url";
    expect(buildVerificationUrl("user-1", "a@example.com")).toBeNull();
    process.env.APP_URL = "ftp://storespy.example";
    expect(buildVerificationUrl("user-1", "a@example.com")).toBeNull();
  });

  it("fails closed to null when the token secret is unset, even with a good APP_URL", () => {
    delete process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
    expect(buildVerificationUrl("user-1", "a@example.com")).toBeNull();
  });
});
