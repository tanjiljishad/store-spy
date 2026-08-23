/**
 * Milestone 12 §4.2 Step 2, vendor 3: TikTok.
 *
 * Two genuinely separate capabilities, same split as meta.ts/google.ts:
 *   - Base TikTok Pixel (page view) — CLIENT-side only. There is no
 *     server-side equivalent for "this browser viewed this page" — see
 *     TikTokPixel.tsx.
 *   - Signup conversion attribution — SERVER-side, via TikTok's Events API,
 *     dispatched from the worker (never the request path). See
 *     conversion-events.ts's dispatchTikTokConversionEvent().
 *
 * DELIBERATELY one host, applying the exact scope scrutiny Vendor 2's
 * review flagged: TikTok's own integration docs/tutorials mention several
 * hosts (business-api.tiktok.com for the Events API; occasional references
 * to region-specific mirrors for advertiser accounts in specific business
 * center regions). Neither is included here:
 *   - business-api.tiktok.com is the Events API's own host — a SERVER-side
 *     endpoint, called only from the worker with a real access token, never
 *     the browser. Same "no CSP entry needed for server-side" reasoning as
 *     Meta's Conversions API and GA4's Measurement Protocol.
 *   - No region-specific pixel/collect host is included, matching Vendor
 *     2's own scope decision on GA4's region shards: this app has no real
 *     TikTok Pixel provisioned yet, so there is no confirmed evidence any
 *     region variant is actually needed, and guessing a host from memory
 *     risks either being wrong (broken tracking, silently CSP-blocked) or
 *     needlessly widening the CSP for a host never actually contacted. If a
 *     real TikTok Pixel ID's actual network requests are ever observed
 *     going to a different host, that is a deliberate, explicit addition to
 *     TIKTOK_PIXEL_CSP_HOSTS below, not something to guess ahead of time.
 * `analytics.tiktok.com` is TikTok's own documented base pixel host for
 * both the loader script (`/i18n/pixel/events.js`) and the events it then
 * reports — the one host with genuine, current-documentation confidence.
 *
 * Public identifier only, this phase: `NEXT_PUBLIC_TIKTOK_PIXEL_ID` is
 * exactly as public as every real TikTok Pixel code already is — visible in
 * the page source of any site that uses one. The Events API access token
 * the server-side half needs is a real secret and explicitly §4.3 scope
 * (the credential vault) — not read anywhere in this file;
 * `isTikTokEventsApiConfigured()` below checks for it and is expected to
 * return `false` until §4.3 ships.
 */

/** Explicit host only — no wildcard, ever. No img-src entry, same reasoning as google.ts: TikTok's pixel reports events via fetch()/sendBeacon (connect-src), not a documented <noscript><img> fallback. No business-api.tiktok.com — see the file comment above. */
export const TIKTOK_PIXEL_CSP_HOSTS = {
  scriptSrc: ["https://analytics.tiktok.com"],
  connectSrc: ["https://analytics.tiktok.com"],
  imgSrc: [] as string[],
};

export function tiktokPixelScriptUrl(pixelId: string): string {
  return `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(pixelId)}&lib=ttq`;
}

/**
 * Both a real pixel ID AND the separate enable flag must be true — same
 * independent-kill-switch rationale as isMetaPixelConfigured()/
 * isGa4Configured(). `NEXT_PUBLIC_`-prefixed: this decision is made
 * entirely client-side, inlined into the bundle at build time.
 */
export function isTikTokPixelConfigured(): boolean {
  return process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ENABLED === "true" && Boolean(process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID);
}

export function getTikTokPixelId(): string | null {
  return isTikTokPixelConfigured() ? (process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID as string) : null;
}

/**
 * §4.3 seam — mirrors dispatchMetaConversionEvent's/dispatchGoogleConversionEvent's
 * own precedent exactly. Deliberately independent of isTikTokPixelConfigured()/
 * the client enable flag — same asymmetry as the other two vendors. Reuses
 * the same public NEXT_PUBLIC_TIKTOK_PIXEL_ID the client tag uses,
 * deliberately — TikTok's Events API call needs the pixel_code the event is
 * reported against, and a second, separately-set "server-side pixel id" env
 * var would just be a footgun with no benefit, since this identifier was
 * never a secret to begin with.
 */
export function isTikTokEventsApiConfigured(): boolean {
  return Boolean(process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN) && Boolean(process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID);
}

export type ConversionDispatchOutcome = "dispatched" | "skipped";

/**
 * Called only from the worker (conversion-events.ts's own dispatch loop),
 * never the request path. `event` is intentionally a minimal shape — same
 * "store the id, not a frozen copy" discipline as the other two vendors:
 * this function looks up whatever it needs (a hashed identifier for
 * TikTok's own user-matching) at the point of actual use.
 */
export async function dispatchTikTokConversionEvent(
  db: { marketingConversionEvent: { update: (args: { where: { id: string }; data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } }) => Promise<unknown> } },
  event: { id: string; userId: string },
): Promise<ConversionDispatchOutcome> {
  if (!isTikTokEventsApiConfigured()) {
    await db.marketingConversionEvent.update({ where: { id: event.id }, data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } });
    return "skipped";
  }

  // PROVIDER SEAM — Milestone 12 §4.3 (credential vault) fills this in: a
  // real POST to https://business-api.tiktok.com/open_api/v1.3/event/track/
  // with a `CompleteRegistration`-shaped event, using TIKTOK_EVENTS_API_
  // ACCESS_TOKEN in the Access-Token header. Provably unreachable this phase
  // — isTikTokEventsApiConfigured() is false until that secret exists
  // (NEXT_PUBLIC_TIKTOK_PIXEL_ID alone is not enough), and every test
  // covering this path asserts exactly that (see
  // conversion-events.integration.test.ts).
  throw new Error("TikTok Events API dispatch is not implemented yet — see the §4.3 PROVIDER SEAM comment above dispatchTikTokConversionEvent().");
}
