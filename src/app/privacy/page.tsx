import Link from "next/link";
import { MarketingPixels } from "@/components/marketing/MarketingPixels";

export const metadata = { title: "Privacy Policy — Bellwether" };

/**
 * Milestone 12 §4.1: exists so signup's ToS checkbox and the cookie
 * consent banner have something real to link to. PLACEHOLDER CONTENT —
 * not drafted or reviewed by counsel. The specific data-handling facts
 * below (what we collect, the export/deletion mechanism) ARE accurate to
 * the current implementation; the legal framing around them is not final.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-[720px] px-7 py-16">
      <Link href="/" className="mb-8 inline-flex items-center gap-2.5 font-display text-[17px] font-bold tracking-tight">
        <span className="h-[11px] w-[11px] rounded-sm bg-sig-price shadow-[0_0_0_4px_rgba(255,182,39,0.14)]" />
        Bellwether
      </Link>
      <h1 className="mb-2 font-display text-2xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mb-8 rounded-md border border-sig-price/35 bg-surface px-4 py-3 font-mono text-[12.5px] text-sig-price">
        Placeholder — this page has not been drafted or reviewed by legal counsel. It exists so
        the signup checkbox and cookie banner have a real page to link to.
      </p>
      <div className="flex flex-col gap-4 font-mono text-[13px] leading-relaxed text-muted">
        <p>We collect the account information you provide (email, password) and the stores you choose to analyze or monitor.</p>
        <p>
          Marketing emails are sent only if you opt in separately at signup, and you can unsubscribe at any
          time with no login required, via the link in any marketing email we send.
        </p>
        <p>
          You can request a full export of your personal data, or request that your account and
          associated data be deleted, from your{" "}
          <Link href="/dashboard/settings" className="text-sig-new hover:text-[#8AD8FF]">
            account settings
          </Link>
          .
        </p>
        <p>We use a cookie to remember your cookie-consent choice. No non-essential tracking cookie is set until you accept.</p>
      </div>
      <MarketingPixels />
    </div>
  );
}
