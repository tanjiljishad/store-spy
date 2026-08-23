import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTikTokPixelId, isTikTokEventsApiConfigured, isTikTokPixelConfigured, TIKTOK_PIXEL_CSP_HOSTS, tiktokPixelScriptUrl } from "../tiktok";

describe("TikTok pixel configuration", () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED;
    delete process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID;
    delete process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  describe("isTikTokPixelConfigured / getTikTokPixelId", () => {
    it("is false (off by default) when neither the flag nor the ID is set", () => {
      expect(isTikTokPixelConfigured()).toBe(false);
      expect(getTikTokPixelId()).toBeNull();
    });

    it("is false when the ID is set but the flag is not — a configured-but-not-yet-activated staging state", () => {
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
      expect(isTikTokPixelConfigured()).toBe(false);
      expect(getTikTokPixelId()).toBeNull();
    });

    it("is false when the flag is true but no ID is set", () => {
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED = "true";
      expect(isTikTokPixelConfigured()).toBe(false);
      expect(getTikTokPixelId()).toBeNull();
    });

    it("is true, and returns the real ID, only when BOTH are set", () => {
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED = "true";
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
      expect(isTikTokPixelConfigured()).toBe(true);
      expect(getTikTokPixelId()).toBe("CABCDEF123456");
    });

    it("a truthy-but-not-literal-true flag value does not enable it", () => {
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED = "1";
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
      expect(isTikTokPixelConfigured()).toBe(false);
    });
  });

  describe("isTikTokEventsApiConfigured", () => {
    it("is false (the expected state this whole phase) when neither the token nor the pixel ID is set", () => {
      expect(isTikTokEventsApiConfigured()).toBe(false);
    });

    it("is false when the token is set but the pixel ID is not — there is no pixel_code to report against", () => {
      process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      expect(isTikTokEventsApiConfigured()).toBe(false);
    });

    it("is false when the pixel ID is set but the token is not", () => {
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
      expect(isTikTokEventsApiConfigured()).toBe(false);
    });

    it("is true once BOTH exist — proving the check itself works, even though nothing sets the token until §4.3", () => {
      process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
      expect(isTikTokEventsApiConfigured()).toBe(true);
    });

    it("is independent of NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED — server-side dispatch can be on while the client pixel stays off", () => {
      process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN = "fake-token-for-this-test-only";
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID = "CABCDEF123456";
      process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED = "false";
      expect(isTikTokEventsApiConfigured()).toBe(true);
      expect(isTikTokPixelConfigured()).toBe(false);
    });
  });

  describe("TIKTOK_PIXEL_CSP_HOSTS", () => {
    it("every host is explicit HTTPS — no wildcard, ever", () => {
      const allHosts = [...TIKTOK_PIXEL_CSP_HOSTS.scriptSrc, ...TIKTOK_PIXEL_CSP_HOSTS.connectSrc, ...TIKTOK_PIXEL_CSP_HOSTS.imgSrc];
      expect(allHosts.length).toBeGreaterThan(0);
      for (const host of allHosts) {
        expect(host).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
        expect(host).not.toContain("*");
      }
    });

    it("does NOT include business-api.tiktok.com — that's the server-side Events API host, never contacted by the browser, see tiktok.ts's own file comment", () => {
      const allHosts = [...TIKTOK_PIXEL_CSP_HOSTS.scriptSrc, ...TIKTOK_PIXEL_CSP_HOSTS.connectSrc, ...TIKTOK_PIXEL_CSP_HOSTS.imgSrc];
      expect(allHosts).not.toContain("https://business-api.tiktok.com");
    });

    it("includes only the single default analytics.tiktok.com host — no region-specific variant guessed ahead of a real account", () => {
      const allHosts = [...TIKTOK_PIXEL_CSP_HOSTS.scriptSrc, ...TIKTOK_PIXEL_CSP_HOSTS.connectSrc, ...TIKTOK_PIXEL_CSP_HOSTS.imgSrc];
      expect(new Set(allHosts)).toEqual(new Set(["https://analytics.tiktok.com"]));
    });
  });

  describe("tiktokPixelScriptUrl", () => {
    it("embeds the pixel id as the sdkid query param, with lib=ttq, on the analytics.tiktok.com host", () => {
      expect(tiktokPixelScriptUrl("CABCDEF123456")).toBe("https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CABCDEF123456&lib=ttq");
    });
  });
});
