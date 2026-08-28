"use client";

import { usePathname } from "next/navigation";
import { setCookieConsent, useCookieConsent } from "@/lib/marketing/cookie-consent-client";

/**
 * Milestone 12 §4.1: "A cookie consent banner on public pages. No
 * non-essential pixel may load before consent." This component itself
 * loads no third-party script — it only records the choice, so nothing
 * here needs to wait on itself.
 *
 * Rendered from the root layout (mounted on every route) rather than a
 * dedicated "public" route group — this repo has no such grouping today,
 * and introducing one is a structural change beyond this phase's own
 * scope (see the Milestone 12 completion report). Instead this component
 * checks its OWN pathname and renders nothing under /dashboard or /admin —
 * those are authenticated surfaces where a marketing cookie prompt has no
 * business appearing.
 *
 * §4.2 addendum: the actual read/write/subscribe mechanism now lives in
 * `cookie-consent.ts` (`useCookieConsent()`/`setCookieConsent()`) — this
 * component was the ONLY caller when §4.1 shipped it, but every §4.2 pixel
 * loader needs the exact same mechanism, so it moved to the shared module
 * rather than staying a private implementation detail here. "Reuse that
 * module, do not write a second consent check" applies to this file too.
 */
const HIDDEN_PATH_PREFIXES = ["/dashboard", "/admin"];

export function CookieConsentBanner() {
  const pathname = usePathname();
  const state = useCookieConsent();

  const hidden = HIDDEN_PATH_PREFIXES.some((prefix) => pathname?.startsWith(prefix));
  if (hidden || state !== "unset") return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface px-6 py-4 shadow-[0_-12px_30px_-15px_rgba(0,0,0,0.6)]"
    >
      <div className="mx-auto flex max-w-[1180px] flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-center font-mono text-[12.5px] text-muted-dim sm:text-left">
          We use a cookie to remember your preferences. With your consent, we may also use cookies for
          marketing analytics — see our{" "}
          <a href="/privacy" className="text-sig-new hover:text-[#8AD8FF]">
            Privacy Policy
          </a>
          .
        </p>
        <div className="flex shrink-0 gap-2.5">
          <button
            type="button"
            onClick={() => setCookieConsent("denied")}
            className="rounded-md border border-line px-4 py-2 font-mono text-[12.5px] font-semibold text-paper transition hover:border-muted"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => setCookieConsent("granted")}
            className="rounded-md bg-sig-price px-4 py-2 font-mono text-[12.5px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
