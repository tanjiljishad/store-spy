"use client";

import { useEffect } from "react";
import { useCookieConsent } from "@/lib/marketing/cookie-consent-client";
import { getTikTokPixelId, tiktokPixelScriptUrl } from "@/lib/marketing/pixels/tiktok";

declare global {
  interface Window {
    ttq?: { page: (...args: unknown[]) => void };
  }
}

/**
 * Milestone 12 §4.2 Step 2: the base TikTok Pixel (page view only) — never
 * a conversion event. The signup conversion event this vendor cares about
 * goes through the SERVER-side seam instead (conversion-events.ts,
 * dispatchTikTokConversionEvent), same split as MetaPixel.tsx/GooglePixel.tsx.
 *
 * DELIBERATE SIMPLIFICATION vs. TikTok's own published base-code snippet:
 * TikTok's official snippet pre-defines a `window.ttq` stub with an
 * internal queue (`_i`/`_t`/`_o` bookkeeping, a `setAndDefer` method
 * factory) so calls made before `events.js` finishes loading are captured
 * and replayed. That internal shape is TikTok's own undocumented
 * implementation detail, not a stable public contract the way Meta's
 * simple `callMethod`/`queue` pair or Google's `dataLayer.push` are —
 * faithfully reimplementing it risks a subtle mismatch against whatever
 * `events.js` actually expects today. Since this component only ever needs
 * ONE call (`ttq.page()`, once), it sidesteps the queue entirely: inject
 * the script, wait for its own `onload`, then call `window.ttq.page()` —
 * the loaded library defines a real, complete `window.ttq` itself, so
 * nothing needs to be pre-queued.
 *
 * Every gate is required, checked in the same order every render:
 *   1. Feature flag + pixel ID configured (`getTikTokPixelId()` — off by
 *      default; returns null unless BOTH are set).
 *   2. Cookie consent state is exactly `"granted"` — reused from
 *      `cookie-consent.ts`, not a second check.
 *
 * `useEffect`, not `useState`+set-in-effect — same rationale as the other
 * two pixel components: this synchronizes with an external system
 * (injecting a `<script>` tag), no React state is ever set inside it.
 */
export function TikTokPixel() {
  const consent = useCookieConsent();
  const pixelId = getTikTokPixelId();

  useEffect(() => {
    if (!pixelId || consent !== "granted") return;
    if (window.ttq) {
      window.ttq.page();
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = tiktokPixelScriptUrl(pixelId);
    script.onload = () => {
      window.ttq?.page();
    };
    document.head.appendChild(script);
  }, [pixelId, consent]);

  return null;
}
