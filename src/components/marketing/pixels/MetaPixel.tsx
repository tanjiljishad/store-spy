"use client";

import { useEffect } from "react";
import { useCookieConsent } from "@/lib/marketing/cookie-consent";
import { getMetaPixelId, META_PIXEL_SCRIPT_URL } from "@/lib/marketing/pixels/meta";

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[]; loaded?: boolean; callMethod?: (...args: unknown[]) => void };
    _fbq?: Window["fbq"];
  }
}

/**
 * Milestone 12 §4.2 Step 2: the base Meta Pixel (PageView only) — never a
 * conversion event, never any user data beyond the page visit itself. The
 * signup conversion event this vendor cares about goes through the
 * SERVER-side seam instead (conversion-events.ts) — this component never
 * fires anything beyond a plain page view.
 *
 * Every gate is required, checked in the same order every render:
 *   1. Feature flag + pixel ID configured (`getMetaPixelId()` — off by
 *      default; returns null unless BOTH are set).
 *   2. Cookie consent state is exactly `"granted"` — reused from
 *      `cookie-consent.ts`, not a second check. `"unset"` and `"denied"`
 *      both mean no script loads; the banner defaults to `"unset"` until a
 *      visitor actively clicks Accept, so a silent visitor never gets
 *      tracked by omission.
 *
 * `useEffect`, not `useState`+set-in-effect — this synchronizes with an
 * external system (injecting a `<script>` tag, mutating `window.fbq`), the
 * textbook case `useEffect` exists for; no React state is ever set inside
 * it, so this does not trip react-hooks/set-state-in-effect the way
 * CookieConsentBanner.tsx's original draft did.
 */
export function MetaPixel() {
  const consent = useCookieConsent();
  const pixelId = getMetaPixelId();

  useEffect(() => {
    if (!pixelId || consent !== "granted") return;
    if (window.fbq) {
      window.fbq("init", pixelId);
      window.fbq("track", "PageView");
      return;
    }

    // Meta's own documented init snippet, adapted: queue calls made before
    // fbevents.js finishes loading, then flush them once it has.
    const fbq: NonNullable<Window["fbq"]> = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue!.push(args);
    } as Window["fbq"] & (() => void);
    fbq.queue = [];
    fbq.loaded = true;
    window.fbq = fbq;
    window._fbq = fbq;

    const script = document.createElement("script");
    script.async = true;
    script.src = META_PIXEL_SCRIPT_URL;
    document.head.appendChild(script);

    fbq("init", pixelId);
    fbq("track", "PageView");
  }, [pixelId, consent]);

  return null;
}
