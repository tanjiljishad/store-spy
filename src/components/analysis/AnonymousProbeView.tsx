import type { AnonymousProbeReport } from "@/lib/analysis/types";

export interface AnonymousProbeViewProps {
  report: AnonymousProbeReport;
  onNewAnalysis: () => void;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Milestone 12 §1.3 (D3 amendment): what an anonymous visitor sees from the
 * shallow probe — deliberately narrower than AnonymousReportView (which
 * still covers GET /api/store/[domain]/report's view of a store someone
 * else already fully crawled, theme included). This shape has no theme:
 * the probe that produced it made exactly one request and never fetched
 * the homepage fingerprinting depends on.
 */
export function AnonymousProbeView({ report, onNewAnalysis }: AnonymousProbeViewProps) {
  const { minCents, maxCents } = report.priceRange;
  const priceLabel =
    minCents === null || maxCents === null
      ? "Not detected"
      : minCents === maxCents
        ? formatCents(minCents)
        : `${formatCents(minCents)} – ${formatCents(maxCents)}`;

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

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line-soft sm:grid-cols-2">
        <div className="relative bg-surface p-5 sm:p-[22px]">
          <span className="absolute right-[18px] top-4 font-mono text-[10px] tracking-wider text-ok">DETECTED</span>
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">Products</div>
          <div className="mt-2 font-display text-[26px] font-bold tracking-tight">{report.productCount.toLocaleString("en-US")}</div>
          <div className="mt-1 font-mono text-[11.5px] text-muted">on the first catalog page</div>
        </div>
        <div className="relative bg-surface p-5 sm:p-[22px]">
          <span className="absolute right-[18px] top-4 font-mono text-[10px] tracking-wider text-ok">DETECTED</span>
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">Price range</div>
          <div className="mt-2 font-display text-[26px] font-bold tracking-tight">{priceLabel}</div>
          <div className="mt-1 font-mono text-[11.5px] text-muted">observed on the first page</div>
        </div>
      </div>

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
