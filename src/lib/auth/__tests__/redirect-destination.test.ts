import { describe, expect, it } from "vitest";
import { authDestination } from "../redirect-destination";

describe("authDestination", () => {
  it("defaults to /dashboard when no store context is given", () => {
    expect(authDestination(undefined)).toBe("/dashboard");
  });

  it("builds a claim URL for a valid domain", () => {
    expect(authDestination("allbirds.com")).toBe("/dashboard/stores/allbirds.com?claim=1");
  });

  it("canonicalizes a full URL down to a bare domain", () => {
    expect(authDestination("https://www.allbirds.com/")).toBe("/dashboard/stores/allbirds.com?claim=1");
  });

  it("falls back to /dashboard for garbage input rather than building a broken path", () => {
    expect(authDestination("not a domain")).toBe("/dashboard");
    expect(authDestination("")).toBe("/dashboard");
  });

  it("a protocol-relative input ('//evil.com') can never smuggle an off-site redirect", () => {
    // canonicalizeDomain strips everything from the first "/" onward, so
    // "//evil.com" canonicalizes to an empty string here — falling back to
    // /dashboard rather than building a broken or exploitable path. More
    // fundamentally: even a non-empty result is always interpolated into a
    // hardcoded "/dashboard/stores/" relative prefix, never a scheme/host,
    // so there's structurally no way for this to leave the app's own origin.
    expect(authDestination("//evil.com")).toBe("/dashboard");
  });
});
