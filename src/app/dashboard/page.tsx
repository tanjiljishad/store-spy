import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { getDashboardSummary } from "@/lib/dashboard/summary";
import { prisma } from "@/lib/db/prisma";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { formatLimit } from "@/lib/format-limit";
import { planLabel } from "@/lib/plan-label";

export const metadata = { title: "Dashboard — Bellwether" };

export default async function DashboardPage() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect("/login");
    throw e;
  }

  const summary = await getDashboardSummary(prisma, user.id);

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted-dim">{planLabel(summary.plan)} plan</span>
          <h1 className="mt-1.5 font-display text-3xl font-bold tracking-tight">Dashboard</h1>
        </div>
        <Link
          href="/"
          className="rounded-md bg-sig-price px-5 py-2.5 font-mono text-[13px] font-semibold text-[#1A1204] transition hover:-translate-y-px hover:bg-[#FFC44D]"
        >
          Analyze a new store
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Store analyses"
          value={`${summary.analyses.used}`}
          sub="unlimited store analysis"
        />
        <StatCard
          label="Analysis access"
          value="Unlimited"
          sub="no lifetime store cap"
        />
        <StatCard
          label="Monitoring"
          value={`${summary.monitoring.slotsUsed} / ${formatLimit(summary.monitoring.slotsLimit)}`}
          sub={summary.monitoring.slotsUsed === 1 ? "active monitor" : "active monitors"}
        />
      </div>

      <div className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim">
        {summary.monitoring.active.length > 1 ? "Monitored stores" : "Current monitoring"}
      </div>
      {summary.monitoring.active.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-8 text-center">
          <p className="font-display text-base font-bold">No competitor monitored yet</p>
          <p className="mt-1.5 font-mono text-xs text-muted-dim">
            Analyze a store, then start monitoring it for real-time change tracking.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {summary.monitoring.active.map((watch) => (
            <li key={watch.domain}>
              <Link
                href={`/dashboard/stores/${encodeURIComponent(watch.domain)}`}
                className="block rounded-xl border border-line-soft bg-surface p-6 transition hover:border-line"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-display text-lg font-bold tracking-tight">{watch.domain}</div>
                    <div className="mt-1 font-mono text-xs text-muted">Last checked {formatRelativeTime(watch.lastCrawledAt)}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-display text-2xl font-bold tracking-tight text-ok">
                      {watch.daysRemaining ?? "∞"}
                    </div>
                    <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">
                      {watch.daysRemaining === null ? "continuous" : "days remaining"}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim">
        Analyzed stores
      </div>
      {summary.analyses.stores.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-8 text-center">
          <p className="font-display text-base font-bold">No stores analyzed yet</p>
          <p className="mt-1.5 font-mono text-xs text-muted-dim">
            {summary.analyses.limit === null ? "Go pick a competitor." : `You have ${summary.analyses.limit} free analyses — go pick a competitor.`}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {summary.analyses.stores.map((s) => (
            <li key={s.domain}>
              <Link
                href={`/dashboard/stores/${encodeURIComponent(s.domain)}`}
                className="block rounded-lg border border-line-soft bg-surface p-4 transition hover:border-line"
              >
                <div className="font-display text-[15px] font-bold tracking-tight">{s.domain}</div>
                <div className="mt-1 font-mono text-[11.5px] text-muted-dim">
                  {s.productCount.toLocaleString("en-US")} products · analyzed {formatRelativeTime(s.analyzedAt)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-line-soft bg-surface p-5">
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-muted-dim">{label}</div>
      <div className="mt-2 font-display text-[28px] font-bold tracking-tight">{value}</div>
      <div className="mt-1 font-mono text-[11.5px] text-muted">{sub}</div>
    </div>
  );
}
