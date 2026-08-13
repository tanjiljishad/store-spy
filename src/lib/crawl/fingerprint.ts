import type { NormalizedTech } from "./types";

/**
 * Detects theme/apps/pixels/payment stack from a store's storefront HTML.
 *
 * Everything here is a heuristic against markup that themes and apps are free
 * to change without notice. A signature going stale silently degrades to
 * "not detected" (null / not in the array) — it never throws and never
 * fabricates a value. Treat APP_SIGNATURES and PIXEL_SIGNATURES as tuning
 * data, not truths: extend them as you see new apps in real crawls.
 *
 * NOT a signal type this file can detect: cookies. The crawler does one
 * plain fetch of the homepage HTML — it never executes JavaScript and never
 * holds a cookie jar across requests, so a third-party app's own cookies
 * (set via document.cookie at runtime) are structurally invisible here. Only
 * signals present in the raw HTML response itself are detectable: script
 * tags (src or inline contents), DOM attributes, and meta tags — all of
 * which live in the SAME homepage fetch this file already receives, so
 * widening from "script src only" to multiple signal types adds no new
 * crawl surface, only richer patterns against data already fetched.
 */

export type AppSignalType = "script" | "dom" | "meta";

export interface AppSignal {
  type: AppSignalType;
  pattern: RegExp;
}

// App slug -> one or more signals, matched with OR semantics (any one
// firing detects the app). `type` documents WHERE in the markup the pattern
// targets, for future maintainers — detection itself still just tests the
// pattern against the whole HTML string, same as before; script src, inline
// script contents, DOM attributes, and meta tags are all already substrings
// of that one string. Keep patterns narrow so a common word doesn't produce
// a false positive across the corpus.
const APP_SIGNATURES: Record<string, AppSignal[]> = {
  klaviyo: [{ type: "script", pattern: /klaviyo\.com|static\.klaviyo\.com|window\.klaviyo/i }],
  judgeme: [{ type: "script", pattern: /judge\.me\/(?:widgets|assets|review)/i }],
  yotpo: [{ type: "script", pattern: /staticw2\.yotpo\.com|yotpo\.com\/widget/i }],
  loox: [{ type: "script", pattern: /loox\.(?:io|app)/i }],
  stamped: [{ type: "script", pattern: /stamped\.io/i }],
  recharge: [{ type: "script", pattern: /rechargeapps\.com|rechargepayments\.com/i }],
  bold_subscriptions: [{ type: "script", pattern: /boldapps\.net|bold-subscriptions/i }],
  gorgias: [{ type: "script", pattern: /gorgias\.chat|gorgias\.com\/gorgias-chat/i }],
  tidio: [{ type: "script", pattern: /code\.tidio\.co/i }],
  smile_io: [{ type: "script", pattern: /smile\.io|sail-horizon\.com\/round/i }],
  privy: [{ type: "script", pattern: /privy\.com|widget\.privy\.com/i }],
  justuno: [{ type: "script", pattern: /justuno\.com/i }],
  aftership: [{ type: "script", pattern: /aftership\.com/i }],
  pagefly: [{ type: "script", pattern: /pagefly\.io/i }],
  gempages: [{ type: "script", pattern: /gempages\.net/i }],
  shogun: [{ type: "script", pattern: /getshogun\.com/i }],
  okendo: [{ type: "script", pattern: /okendo\.io/i }],
  referralcandy: [{ type: "script", pattern: /referralcandy\.com/i }],
  postscript: [{ type: "script", pattern: /postscript\.io/i }],
  attentive: [{ type: "script", pattern: /attentivemobile\.com/i }],
  // Attribution/analytics stack — the single most decision-relevant signal
  // this file can surface: a competitor running one of these is spending
  // real money on paid acquisition and tracking it seriously, not just
  // running the storefront on autopilot. Both a script-domain signal and a
  // DOM-attribute signal per app, since these vendors commonly inject a
  // data-* attribute alongside (or instead of) an inline script reference.
  triplewhale: [
    { type: "script", pattern: /triplewhale\.com|pixel\.triplewhale/i },
    { type: "dom", pattern: /data-tw-|data-triplewhale/i },
  ],
  northbeam: [
    { type: "script", pattern: /northbeam\.io/i },
    { type: "dom", pattern: /data-northbeam/i },
  ],
  elevar: [
    { type: "script", pattern: /elevar\.(?:com|io)|getelevar/i },
    { type: "dom", pattern: /data-elevar/i },
  ],
  hyros: [{ type: "script", pattern: /hyros\.com/i }],
  wicked_reports: [{ type: "script", pattern: /wickedreports\.com/i }],
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

/** Same as detectFromSignatures, for apps carrying more than one signal (script/DOM/meta) — any one match detects the app. */
function detectFromAppSignatures(html: string, signatures: Record<string, AppSignal[]>): string[] {
  const found: string[] = [];
  for (const [key, signals] of Object.entries(signatures)) {
    if (signals.some((s) => s.pattern.test(html))) found.push(key);
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
    apps: detectFromAppSignatures(html, APP_SIGNATURES),
    pixels: detectPixels(html),
    paymentProviders: detectFromSignatures(html, PAYMENT_SIGNATURES),
    emailPlatform: detectEmailPlatform(html),
  };
}
