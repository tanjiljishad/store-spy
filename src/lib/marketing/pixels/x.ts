/**
 * Milestone 12 §4.2 Step 2, vendor 5: X (formerly Twitter).
 *
 * UNLIKE the other four vendors, this file currently has NO client-side
 * half and NO CSP entries at all — deliberately, pending the operator's
 * decision (see the "necessity assessment" note in the completion report
 * before this was built). The operator asked to check whether X's client
 * pixel adds anything a) X's own Conversions API doesn't already cover for
 * conversions, and b) GA4's client tag doesn't already cover for pageview
 * telemetry, BEFORE building it — this file builds only the half nobody
 * questioned: server-side conversion attribution via X's Conversions API,
 * the exact same "prefer server-side" pattern as the other four vendors.
 *
 * `X_PIXEL_ID` (below) is deliberately NOT `NEXT_PUBLIC_`-prefixed, unlike
 * every other vendor's identifier — it is not read by any client code in
 * this codebase right now, since no client component exists yet. If a
 * client pixel is ever added, this becomes a rename to
 * `NEXT_PUBLIC_X_PIXEL_ID` (it was never a secret — same public-identifier
 * status as every other vendor's id), not a new variable.
 *
 * Public identifier only, this phase, for the same reason as the other
 * four vendors' ids. The Conversions API access token the server-side
 * half needs is a real secret and explicitly §4.3 scope (the credential
 * vault) — not read anywhere in this file; `isXConversionsApiConfigured()`
 * below checks for it and is expected to return `false` until §4.3 ships.
 */

/**
 * Both a real pixel/tag ID AND the separate secret must be true — same
 * independent-kill-switch rationale as every other vendor's `is*Configured()`
 * pairs. Deliberately independent of any client-side flag, since none
 * exists yet.
 */
export function isXConversionsApiConfigured(): boolean {
  return Boolean(process.env.X_CONVERSIONS_API_ACCESS_TOKEN) && Boolean(process.env.X_PIXEL_ID);
}

export type ConversionDispatchOutcome = "dispatched" | "skipped";

/**
 * Called only from the worker (conversion-events.ts's own dispatch loop),
 * never the request path. `event` is intentionally a minimal shape — same
 * "store the id, not a frozen copy" discipline as the other four vendors.
 */
export async function dispatchXConversionEvent(
  db: { marketingConversionEvent: { update: (args: { where: { id: string }; data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } }) => Promise<unknown> } },
  event: { id: string; userId: string },
): Promise<ConversionDispatchOutcome> {
  if (!isXConversionsApiConfigured()) {
    await db.marketingConversionEvent.update({ where: { id: event.id }, data: { dispatchStatus: "SKIPPED_NO_CREDENTIAL" } });
    return "skipped";
  }

  // PROVIDER SEAM — Milestone 12 §4.3 (credential vault) fills this in: a
  // real POST to X's Conversions API (the exact current endpoint/request
  // shape is a §4.3-scope detail, not read here, same deferral as
  // LinkedIn's Conversion Rule ID) using X_CONVERSIONS_API_ACCESS_TOKEN.
  // Provably unreachable this phase — isXConversionsApiConfigured() is
  // false until that secret exists, and every test covering this path
  // asserts exactly that (see conversion-events.integration.test.ts).
  throw new Error("X Conversions API dispatch is not implemented yet — see the §4.3 PROVIDER SEAM comment above dispatchXConversionEvent().");
}
