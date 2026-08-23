import Link from "next/link";
import { MarketingPixels } from "@/components/marketing/MarketingPixels";

export const metadata = { title: "Terms of Service — Bellwether" };

/**
 * Milestone 12 §4.1: exists so signup's ToS checkbox has something real to
 * link to. PLACEHOLDER CONTENT — not drafted or reviewed by counsel. Do
 * not treat this as a binding terms document; replace before relying on it
 * for anything legally load-bearing.
 */
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-[720px] px-7 py-16">
      <Link href="/" className="mb-8 inline-flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Bellwether
      </Link>
      <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mb-8 rounded-md border border-sig-price/35 bg-surface px-4 py-3 font-mono text-[12.5px] text-sig-price">
        Placeholder — this page has not been drafted or reviewed by legal counsel. It exists so
        the signup checkbox has a real page to link to. Do not treat it as a binding agreement.
      </p>
      <div className="flex flex-col gap-4 font-mono text-[13px] leading-relaxed text-muted">
        <p>
          By creating a Bellwether account, you agree to use the service in accordance with
          applicable law and to not attempt to disrupt, overload, or gain unauthorized access to
          the platform or the stores it analyzes.
        </p>
        <p>
          Bellwether provides competitive intelligence derived from publicly accessible storefront
          data. We do not guarantee the accuracy, completeness, or availability of any analysis.
        </p>
        <p>Full terms, including liability limits, dispute resolution, and account termination, will be published here.</p>
      </div>
      <MarketingPixels />
    </div>
  );
}
