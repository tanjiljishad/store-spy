"use client";

import { useSyncExternalStore } from "react";
import { COOKIE_CONSENT_COOKIE_NAME, COOKIE_CONSENT_MAX_AGE_SECONDS, parseCookieConsent, type CookieConsentState } from "./cookie-consent";

/**
 * The client-side half of the §4.1/§4.2 cookie consent contract —
 * split out from `cookie-consent.ts` because `useSyncExternalStore` forces
 * "use client" on anything that bundles it, and `cookie-consent.ts` is also
 * imported directly by the signup Route Handler (server, Node runtime).
 */

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
