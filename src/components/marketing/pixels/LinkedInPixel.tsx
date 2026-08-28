"use client";

import { useEffect } from "react";
import { useCookieConsent } from "@/lib/marketing/cookie-consent-client";
import { getLinkedInPartnerId, LINKEDIN_INSIGHT_TAG_SCRIPT_URL } from "@/lib/marketing/pixels/linkedin";

declare global {
  interface Window {
    _linkedin_data_partner_ids?: string[];
    lintrk?: ((...args: unknown[]) => void) & { q?: unknown[] };
  }
}

/**
 * Milestone 12 §4.2 Step 2: the base LinkedIn Insight Tag (page view) —
 * never a conversion event. The signup conversion event this vendor cares
 * about goes through the SERVER-side seam instead (conversion-events.ts,
 * dispatchLinkedInConversionEvent), same split as the other three pixel
 * components. Unlike Meta/Google/TikTok, LinkedIn's Insight Tag has no
 * separate "track a page view" call to make — simply pushing the partner
 * id into `window._linkedin_data_partner_ids` and loading `insight.min.js`
 * is what triggers the page view report, per LinkedIn's own documented
 * snippet (faithfully reproduced below, not simplified — this one, unlike
 * TikTok's, is a small, stable, publicly documented queue pattern).
 *
 * Every gate is required, checked in the same order every render:
 *   1. Feature flag + partner ID configured (`getLinkedInPartnerId()` —
 *      off by default; returns null unless BOTH are set).
 *   2. Cookie consent state is exactly `"granted"` — reused from
 *      `cookie-consent.ts`, not a second check.
 *
 * `useEffect`, not `useState`+set-in-effect — same rationale as the other
 * three pixel components.
 */
export function LinkedInPixel() {
  const consent = useCookieConsent();
  const partnerId = getLinkedInPartnerId();

  useEffect(() => {
    if (!partnerId || consent !== "granted") return;

    window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
    if (!window._linkedin_data_partner_ids.includes(partnerId)) {
      window._linkedin_data_partner_ids.push(partnerId);
    }

    if (window.lintrk) return; // insight.min.js already loaded (or loading) from an earlier mount

    const lintrk: NonNullable<Window["lintrk"]> = function (...args: unknown[]) {
      lintrk.q!.push(args);
    } as Window["lintrk"] & (() => void);
    lintrk.q = [];
    window.lintrk = lintrk;

    const script = document.createElement("script");
    script.async = true;
    script.src = LINKEDIN_INSIGHT_TAG_SCRIPT_URL;
    document.head.appendChild(script);
  }, [partnerId, consent]);

  return null;
}
