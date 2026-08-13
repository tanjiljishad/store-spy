import type { PrismaClient } from "@prisma/client";

/**
 * Recovers `Crawl` rows stuck in RUNNING forever after the process that
 * created them crashed, was killed, or was redeployed mid-crawl — see
 * Milestone 8 Sub-phase A's research doc, Section 7: neither the
 * scheduler's own claim-timeout (which only protects `Store.nextCrawlAt`,
 * so the STORE becomes due again) nor anything else in this codebase ever
 * revisits an orphaned `Crawl` row's own status once its owning process is
 * gone. A crawl is created RUNNING at the very start (see
 * `run-analysis.ts`/`run-scheduled-crawl.ts`) and only ever reaches a
 * terminal status at the end of a successful function call — nothing
 * currently runs "in between" to catch the case where that call never
 * finishes.
 *
 * Deliberately does NOT call `applyCrawlFailureToStore()` or touch
 * `Store.failureStreak`/`tier`: a worker crash is an infrastructure event,
 * not evidence the STORE itself is unreachable, and must never be allowed
 * to demote a perfectly healthy store toward DISABLED. The claim-timeout
 * mechanism already re-queues the store on its own (its `nextCrawlAt` was
 * pushed forward when it was claimed, independent of whether the crawl
 * that followed ever finished); this function only cleans up the stale
 * `Crawl` row itself, for accurate history/observability.
 *
 * A plain typed Prisma `updateMany` — no raw SQL, so none of the project's
 * `AT TIME ZONE 'UTC'` raw-SQL caveats apply here (typed Date comparisons
 * already round-trip correctly regardless of the Postgres session's
 * TimeZone GUC — see AGENTS.md). Idempotent and concurrency-safe by
 * construction: the WHERE clause only ever matches rows still genuinely
 * RUNNING and older than the threshold, so running this twice (or from two
 * workers at once) does no extra work the second time — Postgres's own
 * row-level locking during the UPDATE statement itself is what prevents
 * two concurrent sweeps from double-processing the same row; no
 * `FOR UPDATE SKIP LOCKED` claim step is needed because the UPDATE *is*
 * the whole atomic action, with no follow-up per-row work that could be
 * duplicated.
 */

/**
 * How old a RUNNING crawl must be before it's considered abandoned rather
 * than merely slow. Deliberately well above any legitimate crawl duration:
 * Milestone 8 Sub-phase A's own analysis of `crawl/shopify.ts`'s configured
 * limits (`maxPages=60`, 15s/request timeout with one retry) put even a
 * pathological real crawl at a few minutes at the outside — 30 minutes
 * leaves wide headroom so this sweep can never race a crawl that's simply
 * taking a while, while still surfacing genuinely stuck rows promptly
 * relative to how often the worker is expected to run this (Section 5).
 */
export const STALE_CRAWL_THRESHOLD_MS = 30 * 60_000;

export interface StaleCrawlSweepResult {
  recovered: number;
}

export async function sweepStaleCrawls(
  prisma: PrismaClient,
  now: Date = new Date(),
  thresholdMs: number = STALE_CRAWL_THRESHOLD_MS,
): Promise<StaleCrawlSweepResult> {
  const cutoff = new Date(now.getTime() - thresholdMs);

  const result = await prisma.crawl.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      finishedAt: now,
      errorMessage: `Recovered by stale-crawl sweep: no completion recorded within ${Math.round(
        thresholdMs / 60_000,
      )} minutes of starting (the worker process likely crashed, was killed, or was redeployed mid-crawl).`,
    },
  });

  return { recovered: result.count };
}
