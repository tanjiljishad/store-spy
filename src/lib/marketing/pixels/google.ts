/**
 * Milestone 12 §4.2 Step 2, vendor 2: Google Ads + GA4.
 *
 * Two genuinely separate capabilities, same split as meta.ts:
 *   - GA4 base tag (page_view) — CLIENT-side only. There is no server-side
 *     equivalent for "this browser viewed this page" — see GooglePixel.tsx.
 *   - Signup conversion attribution — SERVER-side, via GA4's Measurement
 *     Protocol, dispatched from the worker (never the request path). See
 *     conversion-events.ts's dispatchGoogleConversionEvent().
 *
 * DELIBERATELY GA4-ONLY client-side, not "GA4 + Google Ads": the client tag
 * is configured with ONLY the GA4 measurement ID (`G-XXXXXXX`), never a
 * Google Ads conversion ID (`AW-XXXXXXX`). gtag.js only talks to
 * googleads.g.doubleclick.net when an AW- id is present in its config — with
 * a GA4-only config, the browser never contacts that host, so it is NOT in
 * GOOGLE_CSP_HOSTS below. Google Ads gets its conversion data by linking the
 * GA4 property to a Google Ads account in Google's own console (external to
 * this app) and importing the SAME server-side Measurement Protocol events
 * this file dispatches — exactly the "prefer server-side conversions"
 * instruction, applied to both halves of this vendor pairing at once. If a
 * future requirement genuinely needs a client-side Ads conversion tag, that
 * is a new, separate CSP host and a new decision, not an oversight here.
 *
 * DELIBERATELY the single default collect endpoint, not the region-sharded
 * ones: GA4's default `www.google-analytics.com` endpoint is what every
 * property uses unless "EU Data Boundary" (a specific, paid-tier, opt-in
 * GA4 admin setting) is turned on, in which case hits instead go to a
 * `regionN.google-analytics.com` shard. Google does not publish a fixed,
 * stable list of these region hosts, so enumerating them would be a guess
 * that could silently go stale — and a wildcard (`*.google-analytics.com`)
 * is explicitly out per this phase's non-negotiables. This CSP therefore
 * only supports the default endpoint; if EU Data Boundary is ever enabled
 * for this property, its hits will be CSP-blocked (a dropped network
 * request, not a broken page) until someone deliberately adds that specific
 * host here. A disclosed scope constraint, not an oversight.
 *
 * Public identifier only, this phase: `NEXT_PUBLIC_GA4_MEASUREMENT_ID` is
 * exactly as public as every real GA4 measurement ID already is — visible
 * in the page source of any site that uses one. The Measurement Protocol
 * API secret the server-side half needs is a real secret and explicitly
 * §4.3 scope (the credential vault) — not read anywhere in this file;
 * `isGoogleMeasurementProtocolConfigured()` below checks for it and is
 * expected to return `false` until §4.3 ships.
 */

/**
 * Explicit hosts only — no wildcard, ever. No img-src entry: unlike Meta's
 * pixel (which falls back to a <noscript><img> tag), gtag.js sends its
 * collect hits via fetch()/sendBeacon(), both governed by connect-src, not
 * img-src — confirmed against the CSP spec's own directive-to-API mapping,
 * not assumed. No googleads.g.doubleclick.net — see the file comment above.
 */
export const GOOGLE_PIXEL_CSP_HOSTS = {
  scriptSrc: ["https://www.googletagmanager.com"],
  connectSrc: ["https://www.google-analytics.com"],
  imgSrc: [] as string[],
};

export function gtagScriptUrl(measurementId: string): string {
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
}

/**
 * Both a real measurement ID AND the separate enable flag must be true —
 * same independent-kill-switch rationale as isMetaPixelConfigured(): an
 * operator can stage a real ID in an environment without activating it, or
 * disable instantly without touching the ID. `NEXT_PUBLIC_`-prefixed: this
 * decision is made entirely client-side, inlined into the bundle at build
 * time, same convention as NEXT_PUBLIC_META_PIXEL_ID.
 */
export function isGa4Configured(): boolean {
  return process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ENABLED === "true" && Boolean(process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID);
}

export function getGa4MeasurementId(): string | null {
  return isGa4Configured() ? (process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID as string) : null;
}

/**
 * §4.3 seam — mirrors dispatchMetaConversionEvent's own precedent exactly.
 * Deliberately independent of isGa4Configured()/the client enable flag: an
 * operator may want server-side conversion reporting on while the client
 * pageview tag stays off, the same asymmetry Meta's own two configured-
 * checks already allow. Reuses the same public NEXT_PUBLIC_GA4_MEASUREMENT_ID
 * the client tag uses, deliberately — Measurement Protocol hits MUST target
 * the same GA4 property as the client tag to unify in reporting and be
 * eligible for Google Ads conversion import, so a second, separately-set
 * "server-side measurement ID" env var would just be a footgun (ops setting
 * the two to different property IDs by mistake) with no actual benefit,
 * since this identifier was never a secret to begin with.
 */
export function isGoogleMeasurementProtocolConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET) && Boolean(process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID);
}

export type ConversionDispatchOutcome = "dispatched" | "skipped";

/**
 * Called only from the worker (conversion-events.ts's own dispatch loop),
 * never the request path. `event` is intentionally a minimal shape — same
 * "store the id, not a frozen copy" discipline as dispatchMetaConversionEvent:
 * this function looks up whatever it needs (a client id / hashed identifier
 * for GA4's own user-matching) at the point of actual use.
 */
export async function dispatchGoogleConversionEvent(
  db: { marketingConversionEvent: { update: (args: { where: { id: string }; data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } }) => Promise<unknown> } },
  event: { id: string; userId: string },
): Promise<ConversionDispatchOutcome> {
  if (!isGoogleMeasurementProtocolConfigured()) {
    await db.marketingConversionEvent.update({ where: { id: event.id }, data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } });
    return "skipped";
  }

  // PROVIDER SEAM — Milestone 12 §4.3 (credential vault) fills this in: a
  // real POST to https://www.google-analytics.com/mp/collect?measurement_id=
  // ...&api_secret=... with a `signup` event, using GOOGLE_MEASUREMENT_PROTOCOL_
  // API_SECRET. Provably unreachable this phase — isGoogleMeasurementProtocol
  // Configured() is false until that secret exists (NEXT_PUBLIC_GA4_MEASUREMENT_ID
  // alone is not enough), and every test covering this path asserts exactly
  // that (see conversion-events.integration.test.ts).
  throw new Error("Google Measurement Protocol dispatch is not implemented yet — see the §4.3 PROVIDER SEAM comment above dispatchGoogleConversionEvent().");
}
