import type { AnalysisStatus } from "@/lib/analysis/types";

export interface ErrorPanelProps {
  domain: string;
  status: AnalysisStatus;
  message: string;
  retryable: boolean;
  onRetry: () => void;
  onNewAnalysis: () => void;
}

const GLYPH_BY_STATUS: Partial<Record<AnalysisStatus, { glyph: string; neutral: boolean; heading: string }>> = {
  non_shopify: { glyph: "NOT A SHOPIFY STORE", neutral: false, heading: "This doesn't appear to be a Shopify store" },
  unreachable: { glyph: "STORE UNREACHABLE", neutral: false, heading: "The store didn't respond" },
  crawl_incomplete: { glyph: "ANALYSIS INCOMPLETE", neutral: true, heading: "We couldn't collect enough from this store" },
  invalid_url: { glyph: "INVALID URL", neutral: true, heading: "That URL can't be analyzed" },
  analysis_limit_reached: { glyph: "ANALYSIS UNAVAILABLE", neutral: true, heading: "This analysis is unavailable" },
  failed: { glyph: "ANALYSIS FAILED", neutral: false, heading: "Something went wrong" },
};

export function ErrorPanel({ domain, status, message, retryable, onRetry, onNewAnalysis }: ErrorPanelProps) {
  const meta = GLYPH_BY_STATUS[status] ?? GLYPH_BY_STATUS.failed!;

  return (
    <div className="mx-auto mt-16 max-w-[820px]">
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]">
        <div className="border-b border-line-soft bg-surface-2 px-[18px] py-[13px]">
          <span className="font-mono text-xs font-semibold tracking-wider text-muted">
            ANALYSIS STOPPED — {domain}
          </span>
        </div>
        <div className="px-8 py-11 text-center">
          <span
            className={`mb-4 inline-block rounded-md border px-3 py-1.5 font-mono text-[13px] tracking-wider ${
              meta.neutral ? "border-line text-muted" : "border-sig-stock/35 text-sig-stock"
            }`}
          >
            {meta.glyph}
          </span>
          <h3 className="mb-2.5 font-display text-[22px] font-bold tracking-tight">{meta.heading}</h3>
          <p className="mx-auto mb-6 max-w-[46ch] text-[15px] text-muted">{message}</p>
          <div className="flex flex-wrap justify-center gap-2.5">
            <button
              className="rounded-md bg-sig-price px-[18px] py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
              onClick={onNewAnalysis}
            >
              Analyze a different store
            </button>
            {retryable && (
              <button
                className="rounded-md border border-line px-[18px] py-2.5 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
                onClick={onRetry}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
