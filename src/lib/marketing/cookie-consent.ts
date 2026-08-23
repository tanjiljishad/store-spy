import { useSyncExternalStore } from "react";

/**
 * Milestone 12 §4.1: "A cookie consent banner on public pages... with the
 * state readable by the pixel layer later." This is the shared contract
 * between the banner (client component, §4.1) and every §4.2 pixel loader —
 * one cookie name/value vocabulary AND one client-side read mechanism
 * (`useCookieConsent()` below), defined once so no pixel component ever
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

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

let listeners: Array<() => void> = [];

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): CookieConsentState | "unset" {
  return parseCookieConsent(readCookie(COOKIE_CONSENT_COOKIE_NAME));
}

function getServerSnapshot(): "unset" {
  return "unset";
}

/**
 * Writes the cookie AND notifies every subscribed component (the banner,
 * every mounted pixel loader) synchronously — a pixel waiting on "unset"
 * re-renders the instant the visitor clicks Accept, with no page reload
 * and no polling.
 */
export function setCookieConsent(next: CookieConsentState): void {
  document.cookie = `${COOKIE_CONSENT_COOKIE_NAME}=${encodeURIComponent(next)}; path=/; max-age=${COOKIE_CONSENT_MAX_AGE_SECONDS}; SameSite=Lax`;
  for (const listener of listeners) listener();
}

/**
 * `useSyncExternalStore`, not `useState`+`useEffect` — the cookie is a
 * genuinely external data source unreadable during SSR, and this is
 * React's own documented mechanism for "server-safe default now, real
 * client value after hydration." See CookieConsentBanner.tsx's own (now
 * historical) comment for the react-hooks/set-state-in-effect lint error
 * the `useState`+`useEffect` version of this originally hit.
 */
export function useCookieConsent(): CookieConsentState | "unset" {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
