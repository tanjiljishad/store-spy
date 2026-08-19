import type { PrismaClient } from "@prisma/client";
import { runScheduledCrawl } from "./run-scheduled-crawl";
import { expireDueWatches } from "./watch";
import type { DnsLookup } from "../security/ssrf-guard";

/**
 * Finds due stores and crawls them. No queue dependency: the claim itself —
 * SELECT ... FOR UPDATE SKIP LOCKED, then immediately pushing nextCrawlAt
 * past a claim window before releasing the lock — is the whole concurrency
 * story. Two scheduler processes (or two overlapping ticks of the same one)
 * running this at the same instant can never claim the same store: whichever
 * transaction commits first moves nextCrawlAt into the future, so the
 * other's WHERE nextCrawlAt <= now() no longer matches that row, and
 * SKIP LOCKED means the second transaction doesn't even block waiting to
 * find that out.
 */

export interface ClaimedStore {
  id: string;
  domain: string;
}

const DEFAULT_BATCH_SIZE = 10;
/**
 * How long a claim holds nextCrawlAt forward. Long enough that a real crawl
 * finishes well inside it; short enough that a worker that crashed
 * mid-crawl doesn't strand the store until its next full cadence cycle —
 * it just looks due again after this window, same as a normal retry.
 */
const CLAIM_TIMEOUT_MS = 10 * 60_000;

export async function claimDueStores(
  prisma: PrismaClient,
  now: Date,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ClaimedStore[]> {
  return prisma.$transaction(async (tx) => {
    // "nextCrawlAt" is timestamp(3) with no time zone; comparing it against a
    // raw-bound Date parameter implicitly casts through the session's
    // TimeZone GUC, not UTC. On any DB server whose session zone isn't UTC
    // (verified live: an embedded instance defaulting to the host OS's
    // zone claimed stores hours before they were actually due), that shift
    // silently breaks the "only claim what's due" guarantee. The explicit
    // AT TIME ZONE 'UTC' cast makes the comparison correct regardless of
    // session config — see the matching fix in diff/persist.ts.
    const rows = await tx.$queryRaw<ClaimedStore[]>`
      SELECT id, domain FROM "Store"
      WHERE tier != 'DISABLED' AND "nextCrawlAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "nextCrawlAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    if (rows.length === 0) return [];

    await tx.store.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { nextCrawlAt: new Date(now.getTime() + CLAIM_TIMEOUT_MS) },
    });

    return rows;
  });
}

export interface SchedulerTickArgs {
  prisma: PrismaClient;
  now?: Date;
  batchSize?: number;
  fetchImpl?: typeof fetch;
  dnsLookup?: DnsLookup;
}

export interface SchedulerTickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  expiredWatches: number;
  results: Array<{ domain: string; outcome: "ok" | "short_circuited" | "failed"; reason?: string }>;
}

export async function runSchedulerTick(args: SchedulerTickArgs): Promise<SchedulerTickResult> {
  const { prisma, fetchImpl, dnsLookup } = args;
  const now = args.now ?? new Date();
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

  // Settle any legacy finite watches before deciding what's due. New FREE and
  // PAID watches have no commercial expiration and are never selected here.
  const { expiredCount } = await expireDueWatches(prisma, now);

  const claimed = await claimDueStores(prisma, now, batchSize);
  const results: SchedulerTickResult["results"] = [];
  let succeeded = 0;
  let failed = 0;

  // Sequential, not parallel: one claimed batch's crawls share this tick's
  // time/resource budget rather than competing for it, and a single store
  // can never monopolize the worker fleet if the fleet is "one tick at a time."
  for (const store of claimed) {
    try {
      const outcome = await runScheduledCrawl({ prisma, store, fetchImpl, dnsLookup, now: new Date() });
      results.push({
        domain: store.domain,
        outcome: outcome.outcome,
        reason: outcome.outcome === "failed" ? outcome.reason : undefined,
      });
      if (outcome.outcome === "failed") failed++;
      else succeeded++;
    } catch (e) {
      // One store's unexpected exception must not take down the rest of the
      // batch — record it and move on. This is genuinely unexpected (crawler
      // and persistence are both designed to return failures, not throw),
      // so it's worth being loud about rather than swallowing silently.
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] unexpected error crawling ${store.domain}:`, e);
      results.push({ domain: store.domain, outcome: "failed", reason });
      failed++;
    }
  }

  return { claimed: claimed.length, succeeded, failed, expiredWatches: expiredCount, results };
}
