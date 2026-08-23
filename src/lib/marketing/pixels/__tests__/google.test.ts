import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGa4MeasurementId, GOOGLE_PIXEL_CSP_HOSTS, gtagScriptUrl, isGa4Configured, isGoogleMeasurementProtocolConfigured } from "../google";

describe("Google (Ads + GA4) configuration", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED;
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    delete process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  describe("isGa4Configured / getGa4MeasurementId", () => {
    it("is false (off by default) when neither the flag nor the ID is set", () => {
      expect(isGa4Configured()).toBe(false);
      expect(getGa4MeasurementId()).toBeNull();
    });

    it("is false when the ID is set but the flag is not — a configured-but-not-yet-activated staging state", () => {
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
      expect(isGa4Configured()).toBe(false);
      expect(getGa4MeasurementId()).toBeNull();
    });

    it("is false when the flag is true but no ID is set", () => {
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED = "true";
      expect(isGa4Configured()).toBe(false);
      expect(getGa4MeasurementId()).toBeNull();
    });

    it("is true, and returns the real ID, only when BOTH are set", () => {
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED = "true";
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
      expect(isGa4Configured()).toBe(true);
      expect(getGa4MeasurementId()).toBe("G-ABC123456");
    });

    it("a truthy-but-not-literal-true flag value does not enable it", () => {
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED = "1";
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
      expect(isGa4Configured()).toBe(false);
    });
  });

  describe("isGoogleMeasurementProtocolConfigured", () => {
    it("is false (the expected state this whole phase) when neither the secret nor the measurement ID is set", () => {
      expect(isGoogleMeasurementProtocolConfigured()).toBe(false);
    });

    it("is false when the secret is set but the measurement ID is not — there is no property to target", () => {
      process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET = "fake-secret-for-this-test-only";
      expect(isGoogleMeasurementProtocolConfigured()).toBe(false);
    });

    it("is false when the measurement ID is set but the secret is not", () => {
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
      expect(isGoogleMeasurementProtocolConfigured()).toBe(false);
    });

    it("is true once BOTH exist — proving the check itself works, even though nothing sets the secret until §4.3", () => {
      process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET = "fake-secret-for-this-test-only";
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
      expect(isGoogleMeasurementProtocolConfigured()).toBe(true);
    });

    it("is independent of NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED — server-side dispatch can be on while the client tag stays off", () => {
      process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET = "fake-secret-for-this-test-only";
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = "G-ABC123456";
      process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED = "false";
      expect(isGoogleMeasurementProtocolConfigured()).toBe(true);
      expect(isGa4Configured()).toBe(false);
    });
  });

  describe("GOOGLE_PIXEL_CSP_HOSTS", () => {
    it("every host is explicit HTTPS — no wildcard, ever", () => {
      const allHosts = [...GOOGLE_PIXEL_CSP_HOSTS.scriptSrc, ...GOOGLE_PIXEL_CSP_HOSTS.connectSrc, ...GOOGLE_PIXEL_CSP_HOSTS.imgSrc];
      expect(allHosts.length).toBeGreaterThan(0);
      for (const host of allHosts) {
        expect(host).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(host).not.toContain("*");
      }
    });

    it("does NOT include googleads.g.doubleclick.net — no client-side Ads conversion tag is ever configured, see google.ts's own file comment", () => {
      const allHosts = [...GOOGLE_PIXEL_CSP_HOSTS.scriptSrc, ...GOOGLE_PIXEL_CSP_HOSTS.connectSrc, ...GOOGLE_PIXEL_CSP_HOSTS.imgSrc];
      expect(allHosts).not.toContain("https://googleads.g.doubleclick.net");
    });

    it("does NOT include any region-sharded google-analytics.com host — only the default global endpoint is supported", () => {
      const allHosts = [...GOOGLE_PIXEL_CSP_HOSTS.scriptSrc, ...GOOGLE_PIXEL_CSP_HOSTS.connectSrc, ...GOOGLE_PIXEL_CSP_HOSTS.imgSrc];
      for (const host of allHosts) {
        expect(host).not.toMatch(/^https:\/\/region\d+\.google-analytics\.com$/);
      }
      expect(allHosts).toContain("https://www.google-analytics.com");
    });
  });

  describe("gtagScriptUrl", () => {
    it("embeds the measurement id as a query param on the googletagmanager.com host", () => {
      expect(gtagScriptUrl("G-ABC123456")).toBe("https://www.googletagmanager.com/gtag/js?id=G-ABC123456");
    });
  });
});
