import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { requirePermission } from "@/lib/admin/guard";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/session";
import { getAnalyticsDashboardData } from "@/lib/admin/analytics/dashboard-data";
import { STANDARD_WINDOWS, type StandardWindow } from "@/lib/admin/analytics/window";
import { formatCents } from "@/lib/money";
import { FunnelBarChart } from "@/components/admin/analytics/FunnelBarChart";
import { AnalysesTrendChart, type TrendChartPoint } from "@/components/admin/analytics/AnalysesTrendChart";

interface AdminAnalyticsPageProps {
  searchParams: Promise<{ window?: string }>;
}

const WINDOW_LABEL: Record<StandardWindow, string> = { "1d": "24h", "7d": "7d", "30d": "30d", "90d": "90d" };

function isStandardWindow(v: string): v is StandardWindow {
  return (STANDARD_WINDOWS as readonly string[]).includes(v);
}

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function rate(count: number, of: number): string {
  return of === 0 ? "—" : pct(count / of);
}

/**
 * Milestone 12 §3.2: "Server Components reading from snapshots." This page
 * calls getAnalyticsDashboardData() exactly once — every number on it comes
 * from MetricSnapshot (via read.ts), never a live aggregate query, so this
 * page load stays cheap no matter how large Event/Crawl/AnalysisUsage grow.
 *
 * Gated on analytics:read specifically (not just "any non-USER role," which
 * AdminLayout already enforces) — that permission is grantable independent
 * of role (§2.1's AdminPermissionGrant), so this re-checks server-side the
 * same way every /api/admin/* route does via requirePermission().
 */
export default async function AdminAnalyticsPage({ searchParams }: AdminAnalyticsPageProps) {
  try {
    await requirePermission("analytics:read");
  } catch (e) {
    if (e instanceof UnauthorizedError || e instanceof ForbiddenError) notFound();
    throw e;
  }

  const { window: windowParam } = await searchParams;
  const window: StandardWindow = windowParam && isStandardWindow(windowParam) ? windowParam : "30d";

  const data = await getAnalyticsDashboardData(prisma, window);

  const trendByDay = new Map<string, TrendChartPoint>();
  for (const p of data.usageCost.dailyTrend) {
    const key = p.day.toISOString().slice(0, 10);
    const label = p.day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const existing = trendByDay.get(key) ?? { day: label, FREE: 0, BASIC: 0, BUSINESS: 0 };
    existing[p.plan] = p.count;
    trendByDay.set(key, existing);
  }
  const trendPoints = [...trendByDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-2xl font-bold tracking-tight">Analytics</h1>
        <span className="font-mono text-[11px] text-muted-dim">
          {data.computedAt ? `as of ${data.computedAt.toLocaleString()}` : "no data yet — waiting on the first worker tick"}
        </span>
      </div>

      <nav className="mt-4 flex gap-3 font-mono text-[13px]">
        {STANDARD_WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/admin/analytics?window=${w}`}
            className={w === window ? "text-sig-new" : "text-muted-dim hover:text-paper"}
          >
            {WINDOW_LABEL[w]}
          </Link>
        ))}
      </nav>

      <Section title="Funnel">
        <FunnelBarChart steps={data.funnel} />
        <table className="mt-3 w-full border-collapse font-mono text-[13px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-muted-dim">
              <th className="py-1.5 pr-4">Step</th>
              <th className="py-1.5 pr-4">Count</th>
              <th className="py-1.5">Conversion from previous step</th>
            </tr>
          </thead>
          <tbody>
            {data.funnel.map((s, i) => (
              <tr key={s.key} className="border-b border-line-soft/60">
                <td className="py-1.5 pr-4">{s.label}</td>
                <td className="py-1.5 pr-4">{s.count}</td>
                <td className="py-1.5 text-muted-dim">{i === 0 ? "—" : rate(s.count, data.funnel[i - 1].count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Activation">
        <StatRow>
          <Stat label="Signups" value={String(data.activation.signups)} />
          <Stat label="Analyzed within 24h" value={`${data.activation.activatedWithin24h} (${rate(data.activation.activatedWithin24h, data.activation.signups)})`} />
          <Stat label="Watched within 7d" value={`${data.activation.watchedWithin7d} (${rate(data.activation.watchedWithin7d, data.activation.signups)})`} />
        </StatRow>
      </Section>

      <Section title="Revenue">
        <StatRow>
          <Stat label="MRR" value={formatCents(data.revenue.mrrCentsTotal)} />
          <Stat label="ARPU" value={formatCents(data.revenue.arpuCents)} />
          <Stat label="New MRR" value={formatCents(data.revenue.newMrrCents)} />
          <Stat label="Expansion MRR" value={formatCents(data.revenue.expansionMrrCents)} />
          <Stat label="Contraction MRR" value={formatCents(data.revenue.contractionMrrCents)} />
          <Stat label="Churned MRR" value={formatCents(data.revenue.churnedMrrCents)} />
        </StatRow>
        <table className="mt-3 w-full border-collapse font-mono text-[13px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-muted-dim">
              <th className="py-1.5 pr-4">Plan</th>
              <th className="py-1.5 pr-4">Active subscriptions</th>
              <th className="py-1.5">MRR</th>
            </tr>
          </thead>
          <tbody>
            {(["BASIC", "BUSINESS"] as const).map((plan) => (
              <tr key={plan} className="border-b border-line-soft/60">
                <td className="py-1.5 pr-4">{plan}</td>
                <td className="py-1.5 pr-4">{data.revenue.activeSubscriptionsByPlan[plan]}</td>
                <td className="py-1.5">{formatCents(data.revenue.mrrCentsByPlan[plan])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.revenue.activeSubscriptionsBySource.length > 0 && (
          <p className="mt-2 font-mono text-[12px] text-muted-dim">
            By source: {data.revenue.activeSubscriptionsBySource.map((s) => `${s.source} ${s.count}`).join(", ")}
          </p>
        )}
      </Section>

      <Section title="Usage and cost">
        <AnalysesTrendChart points={trendPoints} />
        <StatRow>
          <Stat label="Crawl volume" value={String(data.usageCost.crawlVolume)} />
          <Stat label="Crawl failure rate" value={rate(data.usageCost.crawlFailures, data.usageCost.crawlVolume)} />
          <Stat label="SerpAPI calls" value={String(data.usageCost.serpApiCalls)} />
          <Stat label="SerpAPI cost" value={formatCents(data.usageCost.serpApiCostCents)} />
          <Stat label="Active BUSINESS accounts" value={String(data.usageCost.activeBusinessAccounts)} />
          <Stat label="Cost / active BUSINESS account" value={formatCents(data.usageCost.costPerActiveBusinessAccountCents)} />
        </StatRow>
      </Section>

      <Section title="Retention">
        <table className="w-full border-collapse font-mono text-[13px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-muted-dim">
              <th className="py-1.5 pr-4">Cohort month</th>
              <th className="py-1.5 pr-4">Signups</th>
              <th className="py-1.5 pr-4">Ever paid</th>
              <th className="py-1.5">Currently paid</th>
            </tr>
          </thead>
          <tbody>
            {data.retention.map((c) => (
              <tr key={c.cohortMonth.toISOString()} className="border-b border-line-soft/60">
                <td className="py-1.5 pr-4">{c.cohortMonth.toLocaleDateString(undefined, { year: "numeric", month: "short" })}</td>
                <td className="py-1.5 pr-4">{c.cohortSize}</td>
                <td className="py-1.5 pr-4">
                  {c.everPaid} ({rate(c.everPaid, c.cohortSize)})
                </td>
                <td className="py-1.5">
                  {c.currentlyPaid} ({rate(c.currentlyPaid, c.cohortSize)})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.retention.length === 0 && <p className="text-muted-dim">No cohorts yet.</p>}
      </Section>

      <Section title="Operational">
        <StatRow>
          <Stat label="Scheduler lag (overdue stores)" value={String(data.operational.schedulerLag)} />
          <Stat label="Disabled stores" value={String(data.operational.disabledStores)} />
          <Stat label="Stores on a failure streak" value={String(data.operational.storesOnFailureStreak)} />
          <Stat label="Promo redemptions" value={String(data.operational.promoRedemptions)} />
        </StatRow>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-dim">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-6">{children}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[11px] text-muted-dim">{label}</div>
      <div className="font-mono text-[15px] text-paper">{value}</div>
    </div>
  );
}
