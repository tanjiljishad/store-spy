import { describe, expect, it } from "vitest";
import { fingerprintTech } from "../fingerprint";

describe("fingerprintTech", () => {
  it("returns all-null/empty on markup with no recognizable signatures", () => {
    const tech = fingerprintTech("<html><body>hello</body></html>");
    expect(tech).toEqual({
      themeName: null,
      themeVersion: null,
      apps: [],
      pixels: {},
      paymentProviders: [],
      emailPlatform: null,
    });
  });

  it("extracts theme name from the Shopify.theme JS object", () => {
    const html = `<script>var Shopify = Shopify || {}; Shopify.theme = {"name":"Dawn","id":140378898548};</script>`;
    expect(fingerprintTech(html).themeName).toBe("Dawn");
  });

  it("does not fabricate a theme version when none is present", () => {
    const html = `<script>Shopify.theme = {"name":"Dawn"};</script>`;
    expect(fingerprintTech(html).themeVersion).toBeNull();
  });

  it("extracts an explicit theme version when a theme embeds one", () => {
    const html = `<meta name="theme-version" content="15.2.0">`;
    expect(fingerprintTech(html).themeVersion).toBe("15.2.0");
  });

  it("detects multiple apps from script src signatures", () => {
    const html = `
      <script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>
      <script src="https://cdn-widgetsrepo.judge.me/assets/widget.js"></script>
      <div>unrelated</div>
    `;
    expect(fingerprintTech(html).apps).toEqual(["judgeme", "klaviyo"]);
  });

  it("extracts a facebook pixel id", () => {
    const html = `<script>fbq('init', '123456789012345'); fbq('track', 'PageView');</script>`;
    expect(fingerprintTech(html).pixels.facebook).toBe("123456789012345");
  });

  it("extracts a GA4 measurement id distinct from Google Ads", () => {
    const html = `<script>gtag('config', 'G-ABC1234XY'); gtag('config', 'AW-987654321');</script>`;
    const tech = fingerprintTech(html);
    expect(tech.pixels.ga4).toBe("G-ABC1234XY");
    expect(tech.pixels.google_ads).toBe("AW-987654321");
  });

  it("detects payment providers by substring", () => {
    const html = `<div data-shop-pay-button></div><div>Pay with PayPal</div>`;
    const tech = fingerprintTech(html);
    expect(tech.paymentProviders).toContain("shop_pay");
    expect(tech.paymentProviders).toContain("paypal");
  });

  it("picks the first matching email platform, klaviyo before mailchimp", () => {
    const html = `<script src="https://static.klaviyo.com/x.js"></script><a href="https://list-manage.com/subscribe">Sign up</a>`;
    expect(fingerprintTech(html).emailPlatform).toBe("klaviyo");
  });

  it("never throws on malformed Shopify.theme JSON", () => {
    const html = `<script>Shopify.theme = {name: Dawn, broken};</script>`;
    expect(() => fingerprintTech(html)).not.toThrow();
    expect(fingerprintTech(html).themeName).toBeNull();
  });
});
