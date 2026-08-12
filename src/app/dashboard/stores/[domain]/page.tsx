import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canonicalizeDomain } from "@/lib/crawl/shopify";
import { prisma } from "@/lib/db/prisma";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { hasAnalyzedStore, recordAnalysisUsage } from "@/lib/entitlements/analysis-usage";
import { maxActiveMonitoredStores } from "@/lib/entitlements/entitlement-service";
import { buildStoreIntelligenceReport } from "@/lib/intelligence/report";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { daysRemaining } from "@/lib/days-remaining";
import { planLabel } from "@/lib/plan-label";
import { MonitoringStatusCard } from "@/components/analysis/MonitoringStatusCard";
import { StoreActivitySummary } from "@/components/analysis/StoreActivitySummary";
import { GrowthIntelligence } from "@/components/analysis/GrowthIntelligence";
import { AdvertisingSummary } from "@/components/analysis/AdvertisingSummary";
import { ChangeFeedTimeline } from "@/components/analysis/ChangeFeedTimeline";
import { MARKETING_EVENT_TYPES } from "@/lib/marketing/event-types";
import { IntelligenceCard } from "@/components/dashboard/IntelligenceCard";
import { MonitorButton } from "@/components/dashboard/MonitorButton";
import { SectionLabel } from "@/components/dashboard/SectionLabel";

interface StoreIntelligencePageProps {
  params: Promise<{ domain: string }>;
  /**
   * `claim=1` arrives only from the post-signup/login redirect (see
   * AuthForm.tsx) for the exact store an anonymous visitor was just
   * previewing. It spends one analysis credit on an ALREADY-crawled store
   * without triggering a new crawl — see recordAnalysisUsage(), which is
   * idempotent, so a stale/repeated `claim=1` (back button, refresh) is a
   * harmless no-op after the first successful claim, never a double-charge.
   */
  searchParams: Promise<{ claim?: string }>;
}

export default async function StoreIntelligencePage({ params, searchParams }: StoreIntelligencePageProps) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect("/login");
    throw e;
  }

  const { domain: rawDomain } = await params;
  const { claim } = await searchParams;
  const domain = canonicalizeDomain(decodeURIComponent(rawDomain));
  const store = await prisma.store.findUnique({ where: { domain } });
  if (!store) notFound();

  let analyzed = await hasAnalyzedStore(prisma, user.id, store.id);
  let claimLimitReached = false;
  if (!analyzed && claim === "1") {
    const result = await recordAnalysisUsage(prisma, user.id, store.id, user.plan);
    if (result.outcome === "limit_reached") {
      claimLimitReached = true;
    } else {
      analyzed = true; // "recorded" or "already_counted" both mean the user is now entitled to view this
    }
  }

  if (!analyzed) {
    return (
      <div className="mx-auto max-w-[560px] rounded-2xl border border-line bg-surface p-10 text-center">
        <h1 className="font-display text-2xl font-bold tracking-tight">{domain}</h1>
        <p className="mt-3 font-mono text-[13.5px] text-muted">
          {claimLimitReached
            ? "You've used all your free store analyses, so this store can't be added automatically. Upgrade to Basic for unlimited analyses, or free up a slot by choosing your 3 stores."
            : "This store is in Bellwether’s corpus, but you haven’t analyzed it yet — it doesn’t count against your analysis limit until you do."}
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-sig-price px-6 py-3 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
        >
          {claimLimitReached ? "View plans" : "Analyze this store"}
        </Link>
      </div>
    );
  }

  const [report, myWatch, otherActiveWatchCount] = await Promise.all([
    buildStoreIntelligenceReport(prisma, store.id, domain, user.id, true),
    prisma.watchlist.findUnique({ where: { userId_storeId: { userId: user.id, storeId: store.id } } }),
    prisma.watchlist.count({ where: { userId: user.id, monitoringStatus: "ACTIVE", storeId: { not: store.id } } }),
  ]);

  const watchDaysRemaining =
    myWatch?.monitoringStatus === "ACTIVE" && myWatch.monitoringExpiresAt ? daysRemaining(myWatch.monitoringExpiresAt) : null;
  const watchStatus: "ACTIVE" | "EXPIRED" | "NONE" =
    myWatch?.monitoringStatus === "ACTIVE" ? "ACTIVE" : myWatch?.monitoringStatus === "EXPIRED" ? "EXPIRED" : "NONE";

  return (
    <div>
      {/* STORE HEADER */}
      <div className="mb-8 flex flex-wrap items-start justify-between gap-5">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">{domain}</h1>
          <div className="mt-2 flex flex-wrap gap-3.5 font-mono text-[13px] text-muted">
            <span className="text-ok">✓ Shopify verified</span>
            <span>checked {formatRelativeTime(report.monitoring.lastCrawledAt)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            href="/"
            className="rounded-md border border-line px-5 py-2.5 font-mono text-[13px] font-semibold text-paper transition hover:border-muted hover:bg-surface"
          >
            Analyze again
          </Link>
          <MonitorButton
            domain={domain}
            watchStatus={watchStatus}
            daysRemaining={watchDaysRemaining}
            otherActiveWatchCount={otherActiveWatchCount}
            monitorLimit={maxActiveMonitoredStores(user.plan)}
            planLabel={planLabel(user.plan)}
          />
        </div>
      </div>

      <div className="mb-8">
        <MonitoringStatusCard monitoring={report.monitoring} />
      </div>

      {/* STORE OVERVIEW */}
      <SectionLabel>Store overview</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <IntelligenceCard label="Products" field={report.catalog.productCount} format={(v) => v.toLocaleString("en-US")} />
        <IntelligenceCard label="Theme" field={report.identity.theme} format={(v) => v.name ?? "Not detected"} />
        <IntelligenceCard
          label="Average price"
          field={report.catalog.averagePrice}
          format={(v) => `$${(v / 100).toFixed(2)}`}
        />
        <IntelligenceCard label="Apps / technologies" field={report.technology.apps} format={(v) => (v.length > 0 ? `${v.length} detected` : "None detected")} />
      </div>
      {report.technology.apps.status === "OBSERVED" && report.technology.apps.value.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {report.technology.apps.value.map((app) => (
            <span key={app} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
              {app}
            </span>
          ))}
        </div>
      )}
      {report.technology.pixels.status === "OBSERVED" && report.technology.pixels.value.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-dim">Pixels</div>
          <div className="flex flex-wrap gap-2">
            {report.technology.pixels.value.map((pixel) => (
              <span key={pixel} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
                {pixel}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.technology.paymentProviders.status === "OBSERVED" && report.technology.paymentProviders.value.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-dim">Payment providers</div>
          <div className="flex flex-wrap gap-2">
            {report.technology.paymentProviders.value.map((provider) => (
              <span key={provider} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
                {provider}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* BUSINESS INTELLIGENCE */}
      <SectionLabel className="mt-10">Business intelligence</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <IntelligenceCard
          label="Estimated revenue"
          field={report.commercial.revenue}
          format={(v) => `$${(v.minCents / 100).toLocaleString()}–$${(v.maxCents / 100).toLocaleString()}`}
        />
        <IntelligenceCard label="Estimated traffic" field={report.commercial.traffic} format={(v) => v.monthlyVisits.toLocaleString()} />
        <IntelligenceCard label="Review velocity" field={report.reviews.velocity} format={(v) => `${v.reviewsPerMonth}/mo`} />
      </div>

      {/* PRODUCT INTELLIGENCE / ACTIVITY */}
      <SectionLabel className="mt-10">Product activity</SectionLabel>
      <StoreActivitySummary domain={domain} />

      {/* GROWTH SIGNALS */}
      <SectionLabel className="mt-10">Growth signals</SectionLabel>
      <GrowthIntelligence domain={domain} />

      {/* RECENT CHANGES */}
      <SectionLabel className="mt-10">Recent changes</SectionLabel>
      <ChangeFeedTimeline domain={domain} totalCrawls={report.monitoring.totalCrawls} />

      {/* ADVERTISING INTELLIGENCE */}
      <SectionLabel className="mt-10">Advertising intelligence</SectionLabel>
      <AdvertisingSummary domain={domain} />
      <div className="mt-4">
        <ChangeFeedTimeline
          domain={domain}
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
