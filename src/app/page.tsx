"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useAnalysisStream } from "@/hooks/useAnalysisStream";
import { StoreUrlInput } from "@/components/analysis/StoreUrlInput";
import { DetectionLog } from "@/components/analysis/DetectionLog";
import { ErrorPanel } from "@/components/analysis/ErrorPanel";
import { AnonymousProbeView } from "@/components/analysis/AnonymousProbeView";
import { FullReportView } from "@/components/analysis/FullReportView";
import { SiteNav } from "@/components/marketing/SiteNav";
import { PricingSection } from "@/components/marketing/PricingSection";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { Toast } from "@/components/marketing/Toast";
import { MarketingPixels } from "@/components/marketing/MarketingPixels";

export default function HomePage() {
  const { state, start, reset } = useAnalysisStream();
  const { status: sessionStatus } = useSession();
  const [toast, setToast] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const anonymous = sessionStatus === "unauthenticated";

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
            Paste a competitor&apos;s URL. We read the store&apos;s publicly observable signals — products,
            theme, apps, pricing, activity — and turns them into intelligence you&apos;d otherwise spend hours
            assembling by hand.
          </p>
          <StoreUrlInput
            onSubmit={(url) => start(url, turnstileToken)}
            requireTurnstile={anonymous}
            turnstileToken={turnstileToken}
            onTurnstileToken={setTurnstileToken}
          />
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
            onRetry={() => start(state.domain, turnstileToken)}
            onNewAnalysis={reset}
          />
        </div>
      )}

      {/* POST /api/analyze produces "anonymous_probe" (signed out, Milestone 12 §1.3) or "full" (signed in) — "anonymous_preview"/"unanalyzed_preview" are exclusive to GET /api/store/[domain]/report */}
      {state.view === "report" && state.report.access === "anonymous_probe" && (
        <AnonymousProbeView report={state.report} onNewAnalysis={reset} />
      )}
      {state.view === "report" && state.report.access === "full" && (
        <FullReportView report={state.report} onNewAnalysis={reset} />
      )}

      <PricingSection onPlanSelected={showToast} />
      <SiteFooter />

      <Toast message={toast} />
      <MarketingPixels />
    </>
  );
}
