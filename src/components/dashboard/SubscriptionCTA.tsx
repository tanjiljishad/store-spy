import Link from "next/link";

/**
 * Shown only when a FREE user's monitoring has genuinely lapsed (their most
 * recent watch is EXPIRED and none is currently ACTIVE) — never to a user
 * who simply hasn't started monitoring yet, and never to BASIC (no higher
 * tier exists to upsell to in this milestone). Matches the existing CTA-box
 * visual pattern already used in AnonymousReportView rather than
 * introducing a new banner style. No billing exists yet, so "Upgrade to
 * Basic" routes to the existing pricing section on the landing page — the
 * same honest non-checkout placeholder PricingSection already uses.
 */
export function SubscriptionCTA() {
  return (
    <div className="rounded-xl border border-sig-price/30 bg-surface p-7 text-center [background-image:linear-gradient(180deg,rgba(255,182,39,.05),transparent_70%)]">
      <h3 className="font-display text-xl font-bold tracking-tight">Your free 30-day monitoring period has ended.</h3>
      <p className="mx-auto mt-2 max-w-[52ch] text-[14.5px] text-muted">
        Continue monitoring your competitors with Basic: unlimited store analysis, up to 20 monitored stores, and
        continuous competitor monitoring with no 30-day limit.
      </p>
      <Link
        href="/#pricing"
        className="mt-5 inline-block rounded-md bg-sig-price px-6 py-3.5 font-mono text-sm font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
      >
        Upgrade to Basic
      </Link>
    </div>
  );
}
