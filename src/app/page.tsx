"use client";

import { useState } from "react";
import { useAnalysisStream } from "@/hooks/useAnalysisStream";
import { StoreUrlInput } from "@/components/analysis/StoreUrlInput";
import { DetectionLog } from "@/components/analysis/DetectionLog";
import { ErrorPanel } from "@/components/analysis/ErrorPanel";
import { AnonymousReportView } from "@/components/analysis/AnonymousReportView";
import { FullReportView } from "@/components/analysis/FullReportView";
import { SiteNav } from "@/components/marketing/SiteNav";
import { PricingSection } from "@/components/marketing/PricingSection";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Toast } from "@/components/marketing/Toast";

export default function HomePage() {
  const { state, start, reset } = useAnalysisStream();
  const [toast, setToast] = useState<string | null>(null);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }

  return (
    <>
      <SiteNav onHome={reset} />

      {state.view === "idle" && (
        <header className="mx-auto max-w-[1180px] px-7 pb-10 pt-20 text-center">
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-dim">
            Ecommerce competitive intelligence
          </span>
          <h1 className="mx-auto mt-4 max-w-[17ch] font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-[56px]">
            Understand any Shopify store <em className="not-italic text-sig-price">in seconds</em>
          </h1>
          <p className="mx-auto mt-4 max-w-[58ch] text-base text-muted sm:text-[16.5px]">
            Paste a competitor&apos;s URL. Bellwether reads the store&apos;s publicly observable signals — products,
            theme, apps, pricing, activity — and turns them into intelligence you&apos;d otherwise spend hours
            assembling by hand.
          </p>
          <StoreUrlInput onSubmit={start} />
        </header>
      )}

      {state.view === "analyzing" && (
        <div className="px-7 pb-24 pt-16">
          <DetectionLog domain={state.domain} events={state.events} />
        </div>
      )}

      {state.view === "error" && (
        <div className="px-7 pb-24 pt-16">
          <ErrorPanel
            domain={state.domain}
            status={state.status}
            message={state.message}
            retryable={state.retryable}
            onRetry={() => start(state.domain)}
            onNewAnalysis={reset}
          />
        </div>
      )}

      {/* runAnalysis() only ever produces "anonymous_preview" or "full" — "unanalyzed_preview" is exclusive to GET /api/store/[domain]/report */}
      {state.view === "report" && state.report.access === "anonymous_preview" && (
        <AnonymousReportView report={state.report} onNewAnalysis={reset} />
      )}
      {state.view === "report" && state.report.access === "full" && (
        <FullReportView report={state.report} onNewAnalysis={reset} />
      )}

      <PricingSection onPlanSelected={showToast} />
      <SiteFooter />

      <Toast message={toast} />
    </>
  );
}
