import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLinkedInPartnerId, isLinkedInConversionsApiConfigured, isLinkedInPixelConfigured, LINKEDIN_PIXEL_CSP_HOSTS } from "../linkedin";

describe("LinkedIn pixel configuration", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED;
    delete process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID;
    delete process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  describe("isLinkedInPixelConfigured / getLinkedInPartnerId", () => {
    it("is false (off by default) when neither the flag nor the partner ID is set", () => {
      expect(isLinkedInPixelConfigured()).toBe(false);
      expect(getLinkedInPartnerId()).toBeNull();
    });

    it("is false when the partner ID is set but the flag is not — a configured-but-not-yet-activated staging state", () => {
      process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
      expect(isLinkedInPixelConfigured()).toBe(false);
      expect(getLinkedInPartnerId()).toBeNull();
    });

    it("is false when the flag is true but no partner ID is set", () => {
      process.env.NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED = "true";
      expect(isLinkedInPixelConfigured()).toBe(false);
      expect(getLinkedInPartnerId()).toBeNull();
    });

    it("is true, and returns the real ID, only when BOTH are set", () => {
      process.env.NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED = "true";
      process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
      expect(isLinkedInPixelConfigured()).toBe(true);
      expect(getLinkedInPartnerId()).toBe("1234567");
    });

    it("a truthy-but-not-literal-true flag value does not enable it", () => {
      process.env.NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED = "1";
      process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
      expect(isLinkedInPixelConfigured()).toBe(false);
    });
  });

  describe("isLinkedInConversionsApiConfigured", () => {
    it("is false (the expected state this whole phase) when neither the token nor the partner ID is set", () => {
      expect(isLinkedInConversionsApiConfigured()).toBe(false);
    });

    it("is false when the token is set but the partner ID is not", () => {
      process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      expect(isLinkedInConversionsApiConfigured()).toBe(false);
    });

    it("is false when the partner ID is set but the token is not", () => {
      process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
      expect(isLinkedInConversionsApiConfigured()).toBe(false);
    });

    it("is true once BOTH exist — proving the check itself works, even though nothing sets the token until §4.3", () => {
      process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
      expect(isLinkedInConversionsApiConfigured()).toBe(true);
    });

    it("is independent of NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED — server-side dispatch can be on while the client tag stays off", () => {
      process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID = "1234567";
      process.env.NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED = "false";
      expect(isLinkedInConversionsApiConfigured()).toBe(true);
      expect(isLinkedInPixelConfigured()).toBe(false);
    });
  });

  describe("LINKEDIN_PIXEL_CSP_HOSTS", () => {
    it("every host is explicit HTTPS — no wildcard, ever", () => {
      const allHosts = [...LINKEDIN_PIXEL_CSP_HOSTS.scriptSrc, ...LINKEDIN_PIXEL_CSP_HOSTS.connectSrc, ...LINKEDIN_PIXEL_CSP_HOSTS.imgSrc];
      for (const host of allHosts) {
        expect(host).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(host).not.toContain("*");
      }
    });

    it("uses two distinct hosts — the script loader and the collect host are different, unlike Google/TikTok's single-host vendors", () => {
      expect(LINKEDIN_PIXEL_CSP_HOSTS.scriptSrc).toEqual(["https://snap.licdn.com"]);
      expect(LINKEDIN_PIXEL_CSP_HOSTS.connectSrc).toEqual(["https://px.ads.linkedin.com"]);
    });

    it("lists the collect host in BOTH connect-src and img-src — the documented noscript fallback, same treatment as Meta", () => {
      expect(LINKEDIN_PIXEL_CSP_HOSTS.connectSrc).toContain("https://px.ads.linkedin.com");
      expect(LINKEDIN_PIXEL_CSP_HOSTS.imgSrc).toContain("https://px.ads.linkedin.com");
    });
  });
});
