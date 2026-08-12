import type { PrismaClient } from "@prisma/client";
import { crawlShopifyStore } from "../crawl/shopify";
import { normalizeSnapshot } from "../crawl/normalize";
import { runDiffAndPersist } from "../diff/persist";
import { applyCrawlFailureToStore } from "./crawl-outcome";
import type { DnsLookup } from "../security/ssrf-guard";

/**
 * The scheduler's per-store crawl, parallel to run-analysis.ts but for a
 * store the scheduler already claimed rather than a URL a user just typed:
 * no validation, no dedup-window check (the claim already guarantees
 * uniqueness), no SSE — just crawl, persist, report what happened. Shares
 * every primitive with the on-demand path (crawlShopifyStore,
 * runDiffAndPersist, applyCrawlFailureToStore) rather than reimplementing
 * any of them.
 */

type FetchLike = typeof fetch;

export interface RunScheduledCrawlArgs {
  prisma: PrismaClient;
  store: { id: string; domain: string };
  now?: Date;
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
}

export type ScheduledCrawlOutcome =
  | { outcome: "ok"; eventsWritten: number }
  | { outcome: "short_circuited" }
  | { outcome: "failed"; reason: string };

export async function runScheduledCrawl(args: RunScheduledCrawlArgs): Promise<ScheduledCrawlOutcome> {
  const { prisma, store, fetchImpl, dnsLookup } = args;
  const now = args.now ?? new Date();

  const crawlRow = await prisma.crawl.create({
    data: { storeId: store.id, status: "RUNNING", trigger: "SCHEDULED" },
  });

  const crawlResult = await crawlShopifyStore(store.domain, { fetchImpl, dnsLookup });

  if (crawlResult.status !== "ok") {
    await prisma.crawl.update({
      where: { id: crawlRow.id },
      data: {
        status: crawlResult.status === "blocked" ? "BLOCKED" : "FAILED",
        finishedAt: now,
        errorMessage: crawlResult.reason,
      },
    });
    await applyCrawlFailureToStore(prisma, store.id, now);
    return { outcome: "failed", reason: crawlResult.reason };
  }

  const snapshot = normalizeSnapshot(crawlResult.input);

  if (snapshot.products.length === 0) {
    await prisma.crawl.update({
      where: { id: crawlRow.id },
      data: { status: "FAILED", finishedAt: now, errorMessage: "zero products discovered", productCount: 0 },
    });
    await applyCrawlFailureToStore(prisma, store.id, now);
    return { outcome: "failed", reason: "zero products discovered" };
  }

  const outcome = await runDiffAndPersist({ prisma, storeId: store.id, crawlId: crawlRow.id, snapshot, now });

  if (outcome.result?.aborted) {
    return { outcome: "failed", reason: outcome.result.abortReason ?? "diff aborted" };
  }

  return outcome.shortCircuited
    ? { outcome: "short_circuited" }
    : { outcome: "ok", eventsWritten: outcome.eventsWritten };
}
