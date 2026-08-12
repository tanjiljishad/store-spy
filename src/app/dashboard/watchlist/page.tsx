import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { daysRemaining } from "@/lib/days-remaining";
import { maxActiveMonitoredStores } from "@/lib/entitlements/entitlement-service";
import { formatLimit } from "@/lib/format-limit";
import { SubscriptionCTA } from "@/components/dashboard/SubscriptionCTA";

export const metadata = { title: "Watchlist — Bellwether" };

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

  const active = watches.filter((w) => w.monitoringStatus === "ACTIVE");
  const past = watches.filter((w) => w.monitoringStatus !== "ACTIVE");
  const limit = maxActiveMonitoredStores(user.plan);
  // FREE-only: the CTA belongs to the specific moment a free trial lapses,
  // not to a user who's simply never started monitoring — those get the
  // neutral empty state below instead.
  const monitoringHasLapsed = user.plan === "FREE" && active.length === 0 && past.some((w) => w.monitoringStatus === "EXPIRED");

  return (
    <div>
      <h1 className="mb-1.5 font-display text-3xl font-bold tracking-tight">Watchlist</h1>
      <p className="mb-8 font-mono text-[13px] text-muted">
        {limit === null
          ? "Continuous monitoring, unlimited stores. Historical data is never deleted when monitoring stops."
          : `${user.plan === "FREE" ? "Free plan" : "Your plan"}: monitor ${limit === 1 ? "one competitor" : `up to ${formatLimit(limit)} competitors`} at a time. Historical data is never deleted when monitoring expires.`}
      </p>

      {monitoringHasLapsed && (
        <div className="mb-10">
          <SubscriptionCTA />
        </div>
      )}

      <div className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim">
        {active.length > 1 ? `Active watches (${active.length}/${formatLimit(limit)})` : "Active watch"}
      </div>
      {active.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {active.map((w) => (
            <li key={w.id}>
              <WatchCard
                domain={w.store.domain}
                statusLabel={
                  w.monitoringExpiresAt
                    ? `● Active — ${daysRemaining(w.monitoringExpiresAt)} days remaining`
                    : "● Active — continuous monitoring"
                }
                statusClass="text-ok"
                startedAt={w.monitoringStartedAt}
                lastCrawledAt={w.store.lastCrawledAt}
                nextCrawlAt={w.store.tier === "DISABLED" ? null : w.store.nextCrawlAt}
              />
            </li>
          ))}
        </ul>
      ) : (
        !monitoringHasLapsed && (
          <div className="rounded-xl border border-dashed border-line px-6 py-8 text-center">
            <p className="font-display text-base font-bold">
              You can monitor {limit === null ? "unlimited stores" : limit === 1 ? "one store at a time" : `up to ${limit} stores`} on
              your plan
            </p>
            <p className="mt-1.5 font-mono text-xs text-muted-dim">
              Open an analyzed store&apos;s intelligence page to start monitoring it.
            </p>
          </div>
        )
      )}

      {past.length > 0 && (
        <>
          <div className="mb-4 mt-10 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-dim">History</div>
          <ul className="flex flex-col gap-3">
            {past.map((w) => (
              <li key={w.id}>
                <WatchCard
                  domain={w.store.domain}
                  statusLabel={
                    w.monitoringStatus === "EXPIRED" ? "30-day free monitoring expired" : "Monitoring removed"
                  }
                  statusClass="text-muted-dim"
                  startedAt={w.monitoringStartedAt}
                  lastCrawledAt={null}
                  nextCrawlAt={null}
                  expiresAt={w.monitoringExpiresAt}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function WatchCard({
  domain,
  statusLabel,
  statusClass,
  startedAt,
  lastCrawledAt,
  nextCrawlAt,
  expiresAt,
}: {
  domain: string;
  statusLabel: string;
  statusClass: string;
  startedAt: Date | null;
  lastCrawledAt: Date | null;
  nextCrawlAt: Date | null;
  expiresAt?: Date | null;
}) {
  return (
    <Link
      href={`/dashboard/stores/${encodeURIComponent(domain)}`}
      className="block rounded-xl border border-line-soft bg-surface p-5 transition hover:border-line"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-lg font-bold tracking-tight">{domain}</div>
          <div className={`mt-1 font-mono text-[12.5px] font-semibold ${statusClass}`}>{statusLabel}</div>
        </div>
        <div className="flex gap-6 font-mono text-[11.5px] text-muted-dim">
          {startedAt && (
            <div>
              <div>Started</div>
              <div className="mt-0.5 text-muted">{formatRelativeTime(startedAt.toISOString())}</div>
            </div>
          )}
          {expiresAt && (
            <div>
              <div>Expired</div>
              <div className="mt-0.5 text-muted">{formatRelativeTime(expiresAt.toISOString())}</div>
            </div>
          )}
          {lastCrawledAt !== null && (
            <div>
              <div>Last checked</div>
              <div className="mt-0.5 text-muted">{formatRelativeTime(lastCrawledAt?.toISOString() ?? null)}</div>
            </div>
          )}
          {nextCrawlAt !== null && (
            <div>
              <div>Next check</div>
              <div className="mt-0.5 text-muted">{formatRelativeTime(nextCrawlAt?.toISOString() ?? null)}</div>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
