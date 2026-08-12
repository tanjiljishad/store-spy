import type { PrismaClient } from "@prisma/client";
import { nextMarketingCollectionAfterFailure, nextMarketingCollectionAfterSuccess, type CrawlTier } from "./policy";
import { runMarketingCollection } from "./persist";
import type { MarketingAdSource } from "./types";

/**
 * Finds stores due for a marketing-intelligence check and collects them.
 * Same FOR UPDATE SKIP LOCKED claim mechanics as monitoring/scheduler.ts —
 * no queue dependency, no Redis/Kafka/BullMQ. A completely separate claim
 * column (nextMarketingCollectionAt) and a completely separate tick
 * function: this must run on its own, much slower cadence and must never
 * compete with or block the Shopify crawl scheduler.
 */

export interface ClaimedMarketingStore {
  id: string;
  domain: string;
  tier: CrawlTier;
}

const DEFAULT_BATCH_SIZE = 5; // smaller than the Shopify scheduler's — this hits a paid vendor per store
const CLAIM_TIMEOUT_MS = 10 * 60_000; // same window as monitoring/scheduler.ts

export async function claimDueStoresForMarketing(
  prisma: PrismaClient,
  now: Date,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ClaimedMarketingStore[]> {
  return prisma.$transaction(async (tx) => {
    // Same AT TIME ZONE 'UTC' discipline as claimDueStores() in
    // monitoring/scheduler.ts — nextMarketingCollectionAt is timestamp(3)
    // with no time zone, and comparing it against a raw Date parameter
    // without the explicit cast drifts by the session's TimeZone GUC.
    // Also requires a completed Shopify baseline: matching needs a real
    // product catalog, which doesn't exist before that.
    const rows = await tx.$queryRaw<ClaimedMarketingStore[]>`
      SELECT id, domain, tier FROM "Store"
      WHERE tier != 'DISABLED'
        AND "baselinedAt" IS NOT NULL
        AND "nextMarketingCollectionAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY "nextMarketingCollectionAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    if (rows.length === 0) return [];

    await tx.store.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { nextMarketingCollectionAt: new Date(now.getTime() + CLAIM_TIMEOUT_MS) },
    });

    return rows;
  });
}

export interface MarketingSchedulerTickArgs {
  prisma: PrismaClient;
  source: MarketingAdSource;
  now?: Date;
  batchSize?: number;
}

export interface MarketingSchedulerTickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  results: Array<{ domain: string; outcome: "success" | "unavailable" | "error"; reason?: string }>;
}

export async function runMarketingSchedulerTick(args: MarketingSchedulerTickArgs): Promise<MarketingSchedulerTickResult> {
  const { prisma, source } = args;
  const now = args.now ?? new Date();
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

  const claimed = await claimDueStoresForMarketing(prisma, now, batchSize);
  const results: MarketingSchedulerTickResult["results"] = [];
  let succeeded = 0;
  let failed = 0;

  // Sequential, not parallel — same reasoning as the Shopify scheduler tick:
  // one claimed batch shares this tick's budget rather than competing for
  // it, and it keeps concurrent paid-vendor requests bounded to one at a
  // time regardless of batch size.
  for (const store of claimed) {
    try {
      const outcome = await runMarketingCollection({ prisma, storeId: store.id, source, now: new Date() });

      const next =
        outcome.outcome === "SUCCESS"
          ? nextMarketingCollectionAfterSuccess(store.tier, now)
          : nextMarketingCollectionAfterFailure(now);
      // null (DISABLED) never occurs here — claimDueStoresForMarketing()
      // already excludes tier = DISABLED — but stay honest about the type
      // rather than asserting it away.
      if (next) {
        await prisma.store.update({ where: { id: store.id }, data: { nextMarketingCollectionAt: next } });
      }

      if (outcome.outcome === "SUCCESS") {
        succeeded++;
        results.push({ domain: store.domain, outcome: "success" });
      } else {
        failed++;
        results.push({ domain: store.domain, outcome: "unavailable", reason: outcome.reason });
      }
    } catch (e) {
      // One store's unexpected exception must not take down the rest of
      // the batch. Genuinely unexpected — collect/persist are designed to
      // return failures, not throw — so it's worth logging loudly.
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[marketing-scheduler] unexpected error collecting ${store.domain}:`, e);
      await prisma.store.update({
        where: { id: store.id },
        data: { nextMarketingCollectionAt: nextMarketingCollectionAfterFailure(now) },
      });
      failed++;
      results.push({ domain: store.domain, outcome: "error", reason });
    }
  }

  return { claimed: claimed.length, succeeded, failed, results };
}
