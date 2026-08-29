import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { maxActiveMonitoredStores } from "@/lib/entitlements/entitlement-service";
import { getPurchasedPlanSlug } from "@/lib/control-plane/entitlements";
import { formatLimit } from "@/lib/format-limit";

export const metadata = { title: "Store Spy — Watchlist" };

export default async function WatchlistPage() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect("/login");
    throw e;
  }

  const watches = await prisma.watchlist.findMany({
    where: { userId: user.id },
    orderBy: { addedAt: "desc" },
    include: { store: { select: { domain: true, tier: true, lastCrawledAt: true, nextCrawlAt: true } } },
  });
  const active = watches.filter((watch) => watch.monitoringStatus === "ACTIVE");
  const past = watches.filter((watch) => watch.monitoringStatus !== "ACTIVE");
  // Display copy only — the real slot ceiling is enforced by startMonitoring()
  // against the control plane. getPurchasedPlanSlug is the coarse label.
  const plan = await getPurchasedPlanSlug(prisma, user.id);
  const limit = maxActiveMonitoredStores(plan);

  return (
    <div>
      <h1 className="mb-1.5 font-display text-3xl font-bold tracking-tight">Watchlist</h1>
      <p className="mb-8 font-mono text-[13px] text-muted">
        {plan === "FREE" ? "Free plan: monitor 1 store at a time." : `Paid plan: monitor up to ${formatLimit(limit)} stores at a time.`} Historical data is never deleted when monitoring stops.
      </p>

      <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim">
        {active.length > 1 ? `Active watches (${active.length}/${formatLimit(limit)})` : "Active watch"}
      </div>
      {active.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {active.map((watch) => (
            <li key={watch.id}>
              <WatchCard domain={watch.store.domain} statusLabel="● Active monitoring" statusClass="text-ok" startedAt={watch.monitoringStartedAt} lastCrawledAt={watch.store.lastCrawledAt} nextCrawlAt={watch.store.tier === "DISABLED" ? null : watch.store.nextCrawlAt} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed border-line px-6 py-8 text-center">
          <p className="font-display text-base font-bold">You can monitor {limit === 1 ? "one store at a time" : `up to ${limit} stores`} on your plan</p>
          <p className="mt-1.5 font-mono text-xs text-muted-dim">Open an analyzed store&apos;s intelligence page to start monitoring it.</p>
        </div>
      )}

      {past.length > 0 && (
        <>
          <div className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim">History</div>
          <ul className="flex flex-col gap-3">
            {past.map((watch) => (
              <li key={watch.id}>
                <WatchCard domain={watch.store.domain} statusLabel={watch.monitoringStatus === "EXPIRED" ? "Monitoring ended" : "Monitoring removed"} statusClass="text-muted-dim" startedAt={watch.monitoringStartedAt} lastCrawledAt={null} nextCrawlAt={null} expiresAt={watch.monitoringExpiresAt} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function WatchCard({ domain, statusLabel, statusClass, startedAt, lastCrawledAt, nextCrawlAt, expiresAt }: { domain: string; statusLabel: string; statusClass: string; startedAt: Date | null; lastCrawledAt: Date | null; nextCrawlAt: Date | null; expiresAt?: Date | null }) {
  return (
    <Link href={`/dashboard/stores/${encodeURIComponent(domain)}`} className="block rounded-xl border border-line-soft bg-surface p-5 transition hover:border-line">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="font-display text-lg font-bold tracking-tight">{domain}</div><div className={`mt-1 font-mono text-[12.5px] font-semibold ${statusClass}`}>{statusLabel}</div></div>
        <div className="flex gap-6 font-mono text-[11.5px] text-muted-dim">
          {startedAt && <div><div>Started</div><div className="mt-0.5 text-muted">{formatRelativeTime(startedAt.toISOString())}</div></div>}
          {expiresAt && <div><div>Ended</div><div className="mt-0.5 text-muted">{formatRelativeTime(expiresAt.toISOString())}</div></div>}
          {lastCrawledAt !== null && <div><div>Last checked</div><div className="mt-0.5 text-muted">{formatRelativeTime(lastCrawledAt?.toISOString() ?? null)}</div></div>}
          {nextCrawlAt !== null && <div><div>Next check</div><div className="mt-0.5 text-muted">{formatRelativeTime(nextCrawlAt?.toISOString() ?? null)}</div></div>}
        </div>
      </div>
    </Link>
  );
}
