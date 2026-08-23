import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMetaPixelId, isMetaConversionsApiConfigured, isMetaPixelConfigured, META_PIXEL_CSP_HOSTS } from "../meta";

describe("Meta pixel configuration", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ENABLED;
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    delete process.env.META_CONVERSIONS_API_ACCESS_TOKEN;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  describe("isMetaPixelConfigured / getMetaPixelId", () => {
    it("is false (off by default) when neither the flag nor the ID is set", () => {
      expect(isMetaPixelConfigured()).toBe(false);
      expect(getMetaPixelId()).toBeNull();
    });

    it("is false when the ID is set but the flag is not — a configured-but-not-yet-activated staging state", () => {
      process.env.NEXT_PUBLIC_META_PIXEL_ID = "123456789";
      expect(isMetaPixelConfigured()).toBe(false);
      expect(getMetaPixelId()).toBeNull();
    });

    it("is false when the flag is true but no ID is set", () => {
      process.env.NEXT_PUBLIC_META_PIXEL_ENABLED = "true";
      expect(isMetaPixelConfigured()).toBe(false);
      expect(getMetaPixelId()).toBeNull();
    });

    it("is true, and returns the real ID, only when BOTH are set", () => {
      process.env.NEXT_PUBLIC_META_PIXEL_ENABLED = "true";
      process.env.NEXT_PUBLIC_META_PIXEL_ID = "123456789";
      expect(isMetaPixelConfigured()).toBe(true);
      expect(getMetaPixelId()).toBe("123456789");
    });

    it("a truthy-but-not-literal-true flag value does not enable it", () => {
      process.env.NEXT_PUBLIC_META_PIXEL_ENABLED = "1";
      process.env.NEXT_PUBLIC_META_PIXEL_ID = "123456789";
      expect(isMetaPixelConfigured()).toBe(false);
    });
  });

  describe("isMetaConversionsApiConfigured", () => {
    it("is false (the expected state this whole phase) when no token is set", () => {
      expect(isMetaConversionsApiConfigured()).toBe(false);
    });

    it("is true once a token exists — proving the check itself works, even though nothing sets this token until §4.3", () => {
      process.env.META_CONVERSIONS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      expect(isMetaConversionsApiConfigured()).toBe(true);
    });
  });

  describe("META_PIXEL_CSP_HOSTS", () => {
    it("every host is explicit HTTPS — no wildcard, ever", () => {
      const allHosts = [...META_PIXEL_CSP_HOSTS.scriptSrc, ...META_PIXEL_CSP_HOSTS.connectSrc, ...META_PIXEL_CSP_HOSTS.imgSrc];
      for (const host of allHosts) {
        expect(host).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(host).not.toContain("*");
      }
    });
  });
});
