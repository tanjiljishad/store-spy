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
import { TECHNOLOGY_EVENT_TYPES } from "@/lib/monitoring/event-categories";
import { IntelligenceCard } from "@/components/dashboard/IntelligenceCard";
import { MonitorButton } from "@/components/dashboard/MonitorButton";
import { SectionLabel } from "@/components/dashboard/SectionLabel";
import type { IntelligenceField } from "@/lib/analysis/report-contract";

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
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <IntelligenceCard
          label="Domain registered"
          field={report.identity.domainRegisteredAt}
          format={(v) => new Date(v.registeredAt).toLocaleDateString("en-US", { year: "numeric", month: "long" })}
          unavailableHint="Free public registration lookup (RDAP) — some registrars redact this."
        />
        <IntelligenceCard
          label="First archived"
          field={report.identity.firstArchivedAt}
          format={(v) => new Date(v.firstArchivedAt).toLocaleDateString("en-US", { year: "numeric", month: "long" })}
          unavailableHint="Earliest Wayback Machine snapshot found of this store's catalog."
        />
      </div>

      {/* TECHNOLOGY STACK */}
      <SectionLabel className="mt-10">Technology stack</SectionLabel>
      <TechnologyChips apps={report.technology.apps} pixels={report.technology.pixels} paymentProviders={report.technology.paymentProviders} />
      <div className="mt-4">
        <ChangeFeedTimeline
          domain={domain}
          totalCrawls={report.monitoring.totalCrawls}
          eventTypes={[...TECHNOLOGY_EVENT_TYPES]}
          steadyEmptyState={{
            headline: "No technology changes detected yet",
            detail: "App, pixel, payment-provider, and theme changes will appear here as they're observed.",
          }}
        />
      </div>

      {/* BUSINESS INTELLIGENCE */}
      <SectionLabel className="mt-10">Business intelligence</SectionLabel>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <IntelligenceCard
          label="Estimated revenue"
          field={report.commercial.revenue}
          format={(v) => `$${(v.minCents / 100).toLocaleString()}–$${(v.maxCents / 100).toLocaleString()}`}
          unavailableHint="Detected instead: catalog size, average price, and catalog growth activity, below."
        />
        <IntelligenceCard
          label="Estimated traffic"
          field={report.commercial.traffic}
          format={(v) => v.monthlyVisits.toLocaleString()}
          unavailableHint="Detected instead: advertising activity and catalog change frequency, below."
        />
      </div>

      {/* PRODUCT INTELLIGENCE / ACTIVITY */}
      <SectionLabel className="mt-10">Product activity</SectionLabel>
      <StoreActivitySummary
        domain={domain}
        initialData={{
          summary: {
            windowDays: report.growth.windowDays,
            productsAdded: report.growth.productsAdded,
            productsRemoved: report.growth.productsRemoved,
            productsRestored: report.growth.productsRestored,
            priceChanges: report.growth.priceChanges,
            productCountDelta: report.growth.productCountDelta,
            hasEnoughHistory: report.growth.hasEnoughHistory,
          },
          signals: report.growth.signals,
        }}
      />

      {/* GROWTH, PRODUCT VISIBILITY & REVIEW INFRASTRUCTURE */}
      <div className="mt-10">
        <GrowthIntelligence
          domain={domain}
          // JSON round-trip: the composer's Date fields (trend points,
          // review-infrastructure first/lastSeenAt, bestseller trajectory
          // timestamps) must arrive shaped exactly like the /growth route's
          // own Response.json() output (ISO strings), which is what this
          // component's parsing logic expects regardless of which path fed
          // it — passing raw Date objects through the RSC boundary would
          // technically still work (Next.js serializes Date specially) but
          // would silently diverge from the fetch path's actual wire shape.
          initialData={JSON.parse(
            JSON.stringify({
              domain,
              checkedAt: report.meta.generatedAt,
              catalogGrowth: report.growth,
              reviewInfrastructure: report.reviews.infrastructure,
              productHighlights: report.productIntelligence.highlights,
              reviewCoverage: report.reviews.coverage,
            }),
          )}
        />
      </div>
      <div className="mt-4">
        <IntelligenceCard
          label="Review velocity"
          field={report.reviews.velocity}
          format={(v) => `${v.reviewsPerMonth}/mo`}
          unavailableHint="Detected instead: whether a review-collection app is installed, above."
        />
      </div>

      {/* RECENT CHANGES */}
      <SectionLabel className="mt-10">Recent changes</SectionLabel>
      <ChangeFeedTimeline domain={domain} totalCrawls={report.monitoring.totalCrawls} />

      {/* ADVERTISING INTELLIGENCE */}
      <SectionLabel className="mt-10">Advertising intelligence</SectionLabel>
      <AdvertisingSummary domain={domain} initialData={report.marketing} />
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

interface TechnologyChipsProps {
  apps: IntelligenceField<string[]>;
  pixels: IntelligenceField<string[]>;
  paymentProviders: IntelligenceField<string[]>;
}

/** Same chip presentation as FullReportView.tsx's identical helper — kept as two small, in-file copies rather than a shared import, matching this codebase's existing precedent of each report page owning its own small presentational helpers (see Sub-phase A research, Section 3, on FullReportView/dashboard page being independent renderers of shared child components). */
function TechnologyChips({ apps, pixels, paymentProviders }: TechnologyChipsProps) {
  const rows: Array<{ label: string; field: IntelligenceField<string[]> }> = [
    { label: "Apps", field: apps },
    { label: "Pixels", field: pixels },
    { label: "Payment providers", field: paymentProviders },
  ];
  const visible = rows.filter((r) => r.field.status === "OBSERVED" && r.field.value.length > 0);

  if (visible.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line px-5 py-7 text-center">
        <p className="font-display text-base font-bold">No technology signatures detected</p>
        <p className="mt-1.5 font-mono text-xs text-muted-dim">
          No known app, pixel, or payment-provider signature was found on this storefront.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {visible.map(({ label, field }) => {
        if (field.status !== "OBSERVED") return null;
        return (
          <div key={label}>
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-dim">{label}</div>
            <div className="flex flex-wrap gap-2">
              {field.value.map((v) => (
                <span key={v} className="rounded-md border border-line px-3 py-1.5 font-mono text-[12.5px] text-paper">
                  {v}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
