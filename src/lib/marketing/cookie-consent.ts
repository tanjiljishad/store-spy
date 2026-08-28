/**
 * Milestone 12 §4.1: "A cookie consent banner on public pages... with the
 * state readable by the pixel layer later." This is the shared contract
 * between the banner (client component, §4.1) and every §4.2 pixel loader —
 * one cookie name/value vocabulary, defined once so no pixel component ever
 * writes its own consent check. "A pixel that loads before consent is the
 * exact thing §4.1 exists to prevent" — §4.2's own brief, verbatim.
 *
 * Not httpOnly: the banner writes this cookie directly via `document.cookie`
 * (no round trip needed just to record a click), and every pixel component
 * reads it client-side before deciding whether to inject a vendor script.
 * `parseCookieConsent()` below also serves a Server Component or Route
 * Handler that resolves the cookie value itself (via next/headers'
 * `cookies()`) and wants the same parsing — either read path agrees on the
 * same two states.
 *
 * The client-side read/write/subscribe mechanism (`useCookieConsent()`,
 * `setCookieConsent()`) lives in `cookie-consent-client.ts`, not here — that
 * file imports `useSyncExternalStore` from React, which forces "use client"
 * on anything that bundles it. This file is also imported directly by the
 * signup Route Handler (server, Node runtime), so it must stay free of any
 * client-only React API.
 */
export const COOKIE_CONSENT_COOKIE_NAME = "bw-cookie-consent";
export const COOKIE_CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days

export type CookieConsentState = "granted" | "denied";

export function isCookieConsentState(value: string | undefined | null): value is CookieConsentState {
  return value === "granted" || value === "denied";
}

/**
 * Server-side read, for a Server Component or Route Handler. Takes the
 * already-resolved cookie value (from next/headers' `cookies()`) rather
 * than importing that module itself — keeps this file usable from a
 * client component too, and keeps this module trivially unit-testable
 * with no Next.js request context.
 */
export function parseCookieConsent(rawValue: string | undefined | null): CookieConsentState | "unset" {
  return isCookieConsentState(rawValue) ? rawValue : "unset";
}

