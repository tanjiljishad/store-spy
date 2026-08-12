import type { NormalizedTech } from "./types";

/**
 * Detects theme/apps/pixels/payment stack from a store's storefront HTML.
 *
 * Everything here is a heuristic against markup that themes and apps are free
 * to change without notice. A signature going stale silently degrades to
 * "not detected" (null / not in the array) — it never throws and never
 * fabricates a value. Treat APP_SIGNATURES and PIXEL_SIGNATURES as tuning
 * data, not truths: extend them as you see new apps in real crawls.
 */

// App slug -> pattern matched against the raw HTML (script src, inline JS,
// link hrefs — anything in the document). One pattern per app; keep them
// narrow so a common word doesn't produce a false positive across the corpus.
const APP_SIGNATURES: Record<string, RegExp> = {
  klaviyo: /klaviyo\.com|static\.klaviyo\.com|window\.klaviyo/i,
  judgeme: /judge\.me\/(?:widgets|assets|review)/i,
  yotpo: /staticw2\.yotpo\.com|yotpo\.com\/widget/i,
  loox: /loox\.(?:io|app)/i,
  stamped: /stamped\.io/i,
  recharge: /rechargeapps\.com|rechargepayments\.com/i,
  bold_subscriptions: /boldapps\.net|bold-subscriptions/i,
  gorgias: /gorgias\.chat|gorgias\.com\/gorgias-chat/i,
  tidio: /code\.tidio\.co/i,
  smile_io: /smile\.io|sail-horizon\.com\/round/i,
  privy: /privy\.com|widget\.privy\.com/i,
  justuno: /justuno\.com/i,
  aftership: /aftership\.com/i,
  pagefly: /pagefly\.io/i,
  gempages: /gempages\.net/i,
  shogun: /getshogun\.com/i,
  okendo: /okendo\.io/i,
  referralcandy: /referralcandy\.com/i,
  postscript: /postscript\.io/i,
  attentive: /attentivemobile\.com/i,
};

// Platform -> pattern with a capture group for the account/pixel ID.
const PIXEL_SIGNATURES: Array<{ key: string; pattern: RegExp }> = [
  { key: "facebook", pattern: /fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/ },
  { key: "ga4", pattern: /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/ },
  { key: "google_ads", pattern: /gtag\(\s*['"]config['"]\s*,\s*['"](AW-[0-9]+)['"]/ },
  { key: "universal_analytics", pattern: /['"](UA-\d{4,}-\d+)['"]/ },
  { key: "tiktok", pattern: /ttq\.load\(\s*['"]([A-Z0-9]+)['"]/ },
  { key: "pinterest", pattern: /pintrk\(\s*['"]load['"]\s*,\s*['"](\d+)['"]/ },
  { key: "snapchat", pattern: /snaptr\(\s*['"]init['"]\s*,\s*['"]([a-f0-9-]+)['"]/i },
];

const PAYMENT_SIGNATURES: Record<string, RegExp> = {
  shop_pay: /shop[-_ ]?pay/i,
  apple_pay: /apple[-_ ]?pay/i,
  google_pay: /google[-_ ]?pay/i,
  paypal: /paypal/i,
  amazon_pay: /amazon[-_ ]?pay/i,
};

// Checked in priority order: the first match wins. Klaviyo and Omnisend also
// show up in APP_SIGNATURES — this field answers "which ESP", not "is one
// installed", so it stays a single value rather than an array.
const EMAIL_PLATFORM_SIGNATURES: Array<{ key: string; pattern: RegExp }> = [
  { key: "klaviyo", pattern: /klaviyo\.com|window\.klaviyo/i },
  { key: "omnisend", pattern: /omnisend\.com/i },
  { key: "mailchimp", pattern: /list-manage\.com|mailchimp\.com/i },
  { key: "attentive", pattern: /attentivemobile\.com/i },
];

function extractThemeName(html: string): string | null {
  // Common storefront footprint: `Shopify.theme = {"name":"Dawn", ...}`,
  // typically emitted by theme.liquid for analytics. Not present in every
  // theme — falls back to null rather than guessing.
  const match = html.match(/Shopify\.theme\s*=\s*(\{[^;<]*\})/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function extractThemeVersion(html: string): string | null {
  // No universal signal for this exists in storefront HTML — themes are
  // versioned in the Shopify admin, not rendered to visitors. Some themes
  // embed one explicitly; when they don't, this stays null rather than
  // inventing a number that would silently corrupt THEME_CHANGED diffs.

  // <meta name="theme-version" content="15.2.0"> — name and value live in
  // separate attributes, so this needs the whole tag, not a proximity match.
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    if (!/name=["']?[^"'>]*theme[-_ ]?version[^"'>]*["']?/i.test(tag)) continue;
    const content = tag.match(/content=["'](\d+\.\d+(?:\.\d+)?)["']/i);
    if (content) return content[1];
  }

  // Inline fallback: data-theme-version="15.2.0", theme_version: "15.2.0"
  const inline = html.match(/(?:theme[-_]version)["'\s:=]+["']?(\d+\.\d+(?:\.\d+)?)/i);
  return inline ? inline[1] : null;
}

function detectFromSignatures(html: string, signatures: Record<string, RegExp>): string[] {
  const found: string[] = [];
  for (const [key, pattern] of Object.entries(signatures)) {
    if (pattern.test(html)) found.push(key);
  }
  return found.sort();
}

function detectPixels(html: string): Record<string, string> {
  const pixels: Record<string, string> = {};
  for (const { key, pattern } of PIXEL_SIGNATURES) {
    const match = html.match(pattern);
    if (match) pixels[key] = match[1];
  }
  return pixels;
}

function detectEmailPlatform(html: string): string | null {
  for (const { key, pattern } of EMAIL_PLATFORM_SIGNATURES) {
    if (pattern.test(html)) return key;
  }
  return null;
}

export function fingerprintTech(html: string): NormalizedTech {
  return {
    themeName: extractThemeName(html),
    themeVersion: extractThemeVersion(html),
    apps: detectFromSignatures(html, APP_SIGNATURES),
    pixels: detectPixels(html),
    paymentProviders: detectFromSignatures(html, PAYMENT_SIGNATURES),
    emailPlatform: detectEmailPlatform(html),
  };
}
