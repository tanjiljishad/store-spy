/**
 * Milestone 12 §4.2 Step 2, vendor 1: Meta (Facebook/Instagram).
 *
 * Two genuinely separate capabilities, per the doc's own "prefer
 * server-side, client pixels only where there is no server-side
 * equivalent":
 *   - Base Pixel (PageView) — CLIENT-side only. There is no server-side
 *     equivalent for "this anonymous browser viewed this page" —
 *     retargeting/audience-building is inherently a browser-side signal.
 *     See MetaPixel.tsx.
 *   - Signup conversion attribution — SERVER-side, via Meta's Conversions
 *     API, dispatched from the worker (never the request path). See
 *     conversion-events.ts's dispatchMetaConversionEvent().
 *
 * Public identifier only, this phase: `NEXT_PUBLIC_META_PIXEL_ID` is
 * exactly as public as every real Meta Pixel already is — it appears in
 * the page source of any site that uses one, by design (Meta's own docs
 * embed it in client-side snippets). The Conversions API access TOKEN the
 * server-side half needs to actually call Meta's Graph API is a real
 * secret and explicitly §4.3 scope (the credential vault) — not read
 * anywhere in this file; `isMetaConversionsApiConfigured()` below checks
 * for it and is expected to return `false` until §4.3 ships.
 */

/** Explicit hosts only — no wildcard, ever. */
export const META_PIXEL_CSP_HOSTS = {
  scriptSrc: ["https://connect.facebook.net"],
  connectSrc: ["https://www.facebook.com"],
  imgSrc: ["https://www.facebook.com"],
};

export const META_PIXEL_SCRIPT_URL = "https://connect.facebook.net/en_US/fbevents.js";

/**
 * Both a real pixel ID AND the separate enable flag must be true — the
 * flag is a genuine, independent kill switch (an operator can stage a
 * real ID in an environment without activating it, or disable instantly
 * without touching the ID). `NEXT_PUBLIC_`-prefixed: this decision is made
 * entirely client-side, inlined into the bundle at build time, same
 * convention as `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
 */
export function isMetaPixelConfigured(): boolean {
  return process.env.NEXT_PUBLIC_META_PIXEL_ENABLED === "true" && Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID);
}

export function getMetaPixelId(): string | null {
  return isMetaPixelConfigured() ? (process.env.NEXT_PUBLIC_META_PIXEL_ID as string) : null;
}

/**
 * §4.3 seam — mirrors billing/checkout.ts's own PROVIDER SEAM precedent
 * exactly: a real secret this milestone deliberately does not provide, so
 * this reads a plain, undocumented-until-§4.3 env var and is expected to
 * return `false` today. `dispatchMetaConversionEvent()` below checks this
 * before ever attempting a real network call.
 */
export function isMetaConversionsApiConfigured(): boolean {
  return Boolean(process.env.META_CONVERSIONS_API_ACCESS_TOKEN);
}

export type ConversionDispatchOutcome = "dispatched" | "skipped";

/**
 * Called only from the worker (conversion-events.ts's own dispatch loop),
 * never the request path. `event` is intentionally a minimal shape — this
 * function looks up whatever it needs (the user's email, for Meta's own
 * hashed-identifier matching) at the point of actual use rather than
 * trusting a value that might already be stale by dispatch time, the same
 * "store the id, not a frozen copy" discipline this milestone's audit-
 * metadata addendum established.
 */
export async function dispatchMetaConversionEvent(
  db: { marketingConversionEvent: { update: (args: { where: { id: string }; data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } }) => Promise<unknown> } },
  event: { id: string; userId: string },
): Promise<ConversionDispatchOutcome> {
  if (!isMetaConversionsApiConfigured()) {
    await db.marketingConversionEvent.update({ where: { id: event.id }, data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } });
    return "skipped";
  }

  // PROVIDER SEAM — Milestone 12 §4.3 (credential vault) fills this in: a
  // real POST to graph.facebook.com/{pixel_id}/events with a SHA-256'd
  // user identifier and META_CONVERSIONS_API_ACCESS_TOKEN. Provably
  // unreachable this phase — isMetaConversionsApiConfigured() is false
  // until that secret exists, and every test covering this path asserts
  // exactly that (see conversion-events.integration.test.ts).
  throw new Error("Meta Conversions API dispatch is not implemented yet — see the §4.3 PROVIDER SEAM comment above dispatchMetaConversionEvent().");
}
