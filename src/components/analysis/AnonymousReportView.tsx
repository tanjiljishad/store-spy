import type { AnonymousPreviewReport } from "@/lib/analysis/types";
import { FreeReportStrip } from "./FreeReportStrip";

export interface AnonymousReportViewProps {
  report: AnonymousPreviewReport;
  onNewAnalysis: () => void;
}

/**
 * What an anonymous visitor sees after a real crawl — genuinely truncated,
 * per the new business model (spec section 3): a real result, deliberately
 * narrow, then a clear signup CTA. No `{ locked: true }` teaser fields —
 * the rest of the report simply isn't in this payload at all.
 */
export function AnonymousReportView({ report, onNewAnalysis }: AnonymousReportViewProps) {
  return (
    <div className="mx-auto max-w-[820px] px-7 pb-10 pt-14">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-5">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{report.domain}</h2>
          <div className="mt-1.5 flex flex-wrap gap-3.5 font-mono text-[13px] text-muted">
            <span className="text-ok">✓ Shopify verified</span>
            <span>checked just now</span>
          </div>
        </div>
        <button
          className="rounded-md border border-line px-5 py-2.5 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
          onClick={onNewAnalysis}
        >
          New analysis
        </button>
      </div>

      <FreeReportStrip report={report} />

      <div className="mt-9 rounded-xl border border-sig-price/30 bg-surface p-7 text-center [background-image:linear-gradient(180deg,rgba(255,182,39,.05),transparent_70%)]">
        <h3 className="font-display text-xl font-bold tracking-tight">{report.cta}</h3>
        <p className="mx-auto mt-2 max-w-[48ch] text-[14.5px] text-muted">
          Full app stack, real pricing intelligence, catalog and price history, and 30 days of free competitor
          monitoring — no credit card required.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          <a
            href={`/signup?store=${encodeURIComponent(report.domain)}`}
            className="rounded-md bg-sig-price px-6 py-3.5 font-mono text-sm font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
          >
            Create free account
          </a>
          <a
            href={`/login?store=${encodeURIComponent(report.domain)}`}
            className="rounded-md border border-line px-6 py-3.5 font-mono text-sm font-semibold text-paper transition hover:border-muted hover:bg-surface"
          >
            Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
