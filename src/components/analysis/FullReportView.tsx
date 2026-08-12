import type { FullStoreReport } from "@/lib/analysis/types";
import { MonitoringStatusCard } from "./MonitoringStatusCard";
import { StoreActivitySummary } from "./StoreActivitySummary";
import { GrowthIntelligence } from "./GrowthIntelligence";
import { AdvertisingSummary } from "./AdvertisingSummary";
import { ChangeFeedTimeline } from "./ChangeFeedTimeline";
import { IntelligenceCard } from "@/components/dashboard/IntelligenceCard";
import { SectionLabel } from "@/components/dashboard/SectionLabel";
import { MARKETING_EVENT_TYPES } from "@/lib/marketing/event-types";

export interface FullReportViewProps {
  report: FullStoreReport;
  onNewAnalysis: () => void;
}

/**
 * The complete currently-supported intelligence report for a signed-in,
 * entitled user — every field carries its own OBSERVED/ESTIMATED/INFERRED/
 * UNAVAILABLE status (see IntelligenceCard), never a `{ locked: true }`
 * paywall stub. Monitoring *actions* (start/stop) live on the Store
 * Intelligence page in the dashboard, not here — this is the analyze
 * result, that's the management view.
 */
export function FullReportView({ report, onNewAnalysis }: FullReportViewProps) {
  return (
    <div className="mx-auto max-w-[980px] px-7 pb-10 pt-14">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-5">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{report.domain}</h2>
          <div className="mt-1.5 flex flex-wrap gap-3.5 font-mono text-[13px] text-muted">
            <span className="text-ok">✓ Shopify verified</span>
            <span>checked just now</span>
            <span>
              {report.entitlement.analysesUsed} / {report.entitlement.analysesLimit} analyses used
              {report.entitlement.alreadyAnalyzed && " · no credit used for this re-analysis"}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <button
            className="rounded-md border border-line px-5 py-2.5 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
            onClick={onNewAnalysis}
          >
            New analysis
          </button>
          <a
            href={`/dashboard/stores/${encodeURIComponent(report.domain)}`}
            className="rounded-md bg-sig-price px-5 py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
          >
            Full intelligence & monitoring →
          </a>
        </div>
      </div>

      <div className="mb-8">
        <MonitoringStatusCard monitoring={report.monitoring} />
      </div>

      <SectionLabel>Store overview</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <IntelligenceCard label="Products" field={report.productCount} format={(v) => v.toLocaleString("en-US")} />
        <IntelligenceCard label="Theme" field={report.theme} format={(v) => v.name ?? "Not detected"} />
        <IntelligenceCard label="Average price" field={report.averagePrice} format={(v) => `$${(v / 100).toFixed(2)}`} />
        <IntelligenceCard
          label="Apps / technologies"
          field={report.apps}
          format={(v) => (v.length > 0 ? `${v.length} detected` : "None detected")}
        />
      </div>
      {report.apps.status === "OBSERVED" && report.apps.value.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {report.apps.value.map((app) => (
            <span key={app} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
              {app}
            </span>
          ))}
        </div>
      )}
      {report.pixels.status === "OBSERVED" && report.pixels.value.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-dim">Pixels</div>
          <div className="flex flex-wrap gap-2">
            {report.pixels.value.map((pixel) => (
              <span key={pixel} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
                {pixel}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.paymentProviders.status === "OBSERVED" && report.paymentProviders.value.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-dim">Payment providers</div>
          <div className="flex flex-wrap gap-2">
            {report.paymentProviders.value.map((provider) => (
              <span key={provider} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
                {provider}
              </span>
            ))}
          </div>
        </div>
      )}

      <SectionLabel className="mt-9">Business intelligence</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <IntelligenceCard
          label="Estimated revenue"
          field={report.revenue}
          format={(v) => `$${(v.minCents / 100).toLocaleString()}–$${(v.maxCents / 100).toLocaleString()}`}
        />
        <IntelligenceCard label="Estimated traffic" field={report.traffic} format={(v) => v.monthlyVisits.toLocaleString()} />
        <IntelligenceCard label="Review velocity" field={report.reviewVelocity} format={(v) => `${v.reviewsPerMonth}/mo`} />
      </div>

      <SectionLabel className="mt-9">Store activity</SectionLabel>
      <StoreActivitySummary domain={report.domain} />

      <SectionLabel className="mt-9">Growth signals</SectionLabel>
      <GrowthIntelligence domain={report.domain} />

      <SectionLabel className="mt-9">Recent changes</SectionLabel>
      <ChangeFeedTimeline domain={report.domain} totalCrawls={report.monitoring.totalCrawls} />

      <SectionLabel className="mt-9">Advertising intelligence</SectionLabel>
      <AdvertisingSummary domain={report.domain} />
      <div className="mt-4">
        <ChangeFeedTimeline
          domain={report.domain}
          totalCrawls={report.monitoring.totalCrawls}
          eventTypes={[...MARKETING_EVENT_TYPES]}
          steadyEmptyState={{
            headline: "No advertising changes detected yet",
            detail: "New ads, removed ads, or product matches will appear here as they're observed.",
          }}
        />
      </div>
    </div>
  );
}
