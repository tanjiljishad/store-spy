"use client";

import { useEffect } from "react";
import { useCookieConsent } from "@/lib/marketing/cookie-consent-client";
import { getGa4MeasurementId, gtagScriptUrl } from "@/lib/marketing/pixels/google";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Milestone 12 §4.2 Step 2: the GA4 base tag (page_view/session telemetry
 * only) — never a conversion event. The signup conversion event this vendor
 * cares about goes through the SERVER-side seam instead (conversion-events.ts,
 * dispatchGoogleConversionEvent), same split as MetaPixel.tsx.
 *
 * Configured with ONLY the GA4 measurement ID, deliberately — never a
 * Google Ads (`AW-`) id. See google.ts's own file comment: that's what
 * keeps googleads.g.doubleclick.net out of the CSP entirely.
 *
 * Every gate is required, checked in the same order every render:
 *   1. Feature flag + measurement ID configured (`getGa4MeasurementId()` —
 *      off by default; returns null unless BOTH are set).
 *   2. Cookie consent state is exactly `"granted"` — reused from
 *      `cookie-consent.ts`, not a second check.
 *
 * `useEffect`, not `useState`+set-in-effect — same rationale as
 * MetaPixel.tsx: this synchronizes with an external system (injecting a
 * `<script>` tag, mutating `window.gtag`/`window.dataLayer`), no React
 * state is ever set inside it.
 */
export function GooglePixel() {
  const consent = useCookieConsent();
  const measurementId = getGa4MeasurementId();

  useEffect(() => {
    if (!measurementId || consent !== "granted") return;
    if (window.gtag) {
      window.gtag("config", measurementId);
      return;
    }

    // Google's own documented gtag.js snippet, adapted: queue calls made
    // before gtag/js finishes loading (dataLayer.push), then it drains
    // the queue itself once loaded — no manual flush needed, unlike
    // Meta's callMethod/queue pattern.
    window.dataLayer = window.dataLayer || [];
    const gtag: NonNullable<Window["gtag"]> = (...args: unknown[]) => {
      window.dataLayer!.push(args);
    };
    window.gtag = gtag;

    const script = document.createElement("script");
    script.async = true;
    script.src = gtagScriptUrl(measurementId);
    document.head.appendChild(script);

    gtag("js", new Date());
    gtag("config", measurementId);
  }, [measurementId, consent]);

  return null;
}
