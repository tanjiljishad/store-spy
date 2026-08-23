/**
 * Milestone 12 §4.2 Step 2, vendor 4: LinkedIn.
 *
 * Two genuinely separate capabilities, same split as the other three
 * vendors — and confirmed explicitly by the operator before this vendor
 * was built: "LinkedIn's Insight Tag has no meaningful server-side
 * equivalent for pageview, but its Conversions API does exist for
 * conversions — same split as the other three."
 *   - Base Insight Tag (page view) — CLIENT-side only. There is no
 *     server-side equivalent for "this browser viewed this page" — see
 *     LinkedInPixel.tsx.
 *   - Signup conversion attribution — SERVER-side, via LinkedIn's
 *     Conversions API, dispatched from the worker (never the request
 *     path). See conversion-events.ts's dispatchLinkedInConversionEvent().
 *
 * TWO hosts, unlike Google's/TikTok's one: LinkedIn's own documented
 * Insight Tag snippet includes a real `<noscript><img>` fallback
 * (`https://px.ads.linkedin.com/collect/?pid=...&fmt=gif`), the same
 * pattern Meta's pixel uses — not the fetch/sendBeacon-only pattern Google
 * and TikTok use. That noscript fallback, and the JS-loaded tag's own
 * tracking calls, both target the SAME collect host
 * (px.ads.linkedin.com), so it is listed in both connect-src (the JS path)
 * and img-src (the noscript path) — mirroring Meta's own two-directive
 * treatment for exactly the same documented reason, not guessed by
 * analogy. `snap.licdn.com` is the separate, unrelated script-loader host
 * (`insight.min.js`) and only ever needs script-src.
 *
 * Public identifier only, this phase: `NEXT_PUBLIC_LINKEDIN_PARTNER_ID` is
 * exactly as public as every real LinkedIn Insight Tag partner ID already
 * is — visible in the page source of any site that uses one. The
 * Conversions API access token the server-side half needs is a real
 * secret and explicitly §4.3 scope (the credential vault) — not read
 * anywhere in this file; `isLinkedInConversionsApiConfigured()` below
 * checks for it and is expected to return `false` until §4.3 ships.
 */

/** Explicit hosts only — no wildcard, ever. */
export const LINKEDIN_PIXEL_CSP_HOSTS = {
  scriptSrc: ["https://snap.licdn.com"],
  connectSrc: ["https://px.ads.linkedin.com"],
  imgSrc: ["https://px.ads.linkedin.com"],
};

export const LINKEDIN_INSIGHT_TAG_SCRIPT_URL = "https://snap.licdn.com/li.lms-analytics/insight.min.js";

/**
 * Both a real partner ID AND the separate enable flag must be true — same
 * independent-kill-switch rationale as every other vendor's `is*Configured()`.
 */
export function isLinkedInPixelConfigured(): boolean {
  return process.env.NEXT_PUBLIC_LINKEDIN_PIXEL_ENABLED === "true" && Boolean(process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID);
}

export function getLinkedInPartnerId(): string | null {
  return isLinkedInPixelConfigured() ? (process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID as string) : null;
}

/**
 * §4.3 seam — mirrors the other three vendors' precedent exactly.
 * Deliberately independent of isLinkedInPixelConfigured()/the client
 * enable flag. Reuses the same public NEXT_PUBLIC_LINKEDIN_PARTNER_ID the
 * client tag uses, same footgun-avoidance reasoning as Google/TikTok — a
 * real integration will likely also need a separate Conversion Rule ID
 * (a LinkedIn Campaign Manager concept distinct from the partner id); that
 * detail is deferred to §4.3, same as every other vendor's exact request
 * shape.
 */
export function isLinkedInConversionsApiConfigured(): boolean {
  return Boolean(process.env.LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN) && Boolean(process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID);
}

export type ConversionDispatchOutcome = "dispatched" | "skipped";

/**
 * Called only from the worker (conversion-events.ts's own dispatch loop),
 * never the request path. `event` is intentionally a minimal shape — same
 * "store the id, not a frozen copy" discipline as the other three vendors.
 */
export async function dispatchLinkedInConversionEvent(
  db: { marketingConversionEvent: { update: (args: { where: { id: string }; data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } }) => Promise<unknown> } },
  event: { id: string; userId: string },
): Promise<ConversionDispatchOutcome> {
  if (!isLinkedInConversionsApiConfigured()) {
    await db.marketingConversionEvent.update({ where: { id: event.id }, data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } });
    return "skipped";
  }

  // PROVIDER SEAM — Milestone 12 §4.3 (credential vault) fills this in: a
  // real POST to https://api.linkedin.com/rest/conversionEvents with
  // LINKEDIN_CONVERSIONS_API_ACCESS_TOKEN as a bearer token and a
  // Conversion Rule ID (a §4.3-scope detail, not read here). Provably
  // unreachable this phase — isLinkedInConversionsApiConfigured() is false
  // until that secret exists, and every test covering this path asserts
  // exactly that (see conversion-events.integration.test.ts).
  throw new Error("LinkedIn Conversions API dispatch is not implemented yet — see the §4.3 PROVIDER SEAM comment above dispatchLinkedInConversionEvent().");
}
