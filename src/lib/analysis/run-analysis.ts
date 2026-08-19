import type { PrismaClient } from "@prisma/client";
import { canonicalizeDomain, crawlShopifyStore, type CrawlResult } from "../crawl/shopify";
import { normalizeSnapshot } from "../crawl/normalize";
import { runDiffAndPersist } from "../diff/persist";
import type { DnsLookup } from "../security/ssrf-guard";
import { applyCrawlFailureToStore } from "../monitoring/crawl-outcome";
import { getAnalysisUsage, hasAnalyzedStore, recordAnalysisUsage } from "../entitlements/analysis-usage";
import { isUnderLimit } from "../entitlements/plan-limits";
import type { PlanTier } from "../entitlements/plan-limits";
import { permanentlyUnavailable, unavailable } from "./report-contract";
import { enrichDomainAgeIfUnknown } from "../enrichment/domain-age";
import { collectStorefrontReviewObservations } from "../reviews/collect";
import type { AnalysisReport, AnalysisSseEvent, AnalysisStatus, FullStoreReport } from "./types";

/**
 * Orchestrates one product-facing "analyze this store" request: validate,
 * crawl, persist (via the existing engine), and hand back a report shaped
 * by who's asking. This is the ONE place that decides what a browser is
 * allowed to see — buildReport()/buildFullStoreReport() below are the
 * entire contract, not a filter applied later.
 *
 * No queue, no worker: this runs in-process for the duration of the request,
 * emitting onEvent() calls the API route streams out as they happen. Real
 * progress, not polling a fixed set of stages.
 */

type FetchLike = typeof fetch;

export interface RunAnalysisArgs {
  prisma: PrismaClient;
  urlInput: string;
  onEvent: (event: AnalysisSseEvent) => void;
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
  /** Null for an anonymous caller — the crawl still runs (shared corpus value), but no usage credit is checked or spent. */
  caller?: { userId: string; plan: PlanTier } | null;
}

/** A RUNNING crawl older than this is treated as abandoned, not a live duplicate. */
const DEDUP_WINDOW_MS = 2 * 60_000;

export async function runAnalysis(args: RunAnalysisArgs): Promise<void> {
  const { prisma, urlInput, onEvent, fetchImpl, dnsLookup, caller = null } = args;

  onEvent({ type: "status", status: "validating" });

  const domain = canonicalizeDomain(urlInput);
  if (!domain || !domain.includes(".") || /\s/.test(domain)) {
    onEvent({
      type: "error",
      status: "invalid_url",
      message: "Enter a full store URL, like https://store-name.com",
      retryable: false,
    });
    return;
  }

  const store = await prisma.store.upsert({
    where: { domain },
    create: { domain, platform: "SHOPIFY" },
    update: {},
  });

  // Entitlement pre-check: cheap and read-only, purely to fail fast for a
  // caller who's obviously already at their limit — a request that's going
  // to be rejected regardless shouldn't cost a real fetch against someone's
  // storefront. This is NOT the authoritative gate (see below): it only
  // reads, it never records, so it introduces no race condition to worry
  // about. Anonymous callers (caller === null) skip this entirely — the
  // crawl still runs and benefits the shared corpus, same as it always has.
  if (caller) {
    const analyzed = await hasAnalyzedStore(prisma, caller.userId, store.id);
    if (!analyzed) {
      const usage = await getAnalysisUsage(prisma, caller.userId);
      if (!isUnderLimit(usage.used, usage.limit)) {
        emitLimitReached(onEvent);
        return;
      }
    }
  }

  const recentRunning = await prisma.crawl.findFirst({
    where: { storeId: store.id, status: "RUNNING", startedAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) } },
    orderBy: { startedAt: "desc" },
  });
  if (recentRunning) {
    onEvent({
      type: "error",
      status: "failed",
      message: "An analysis for this store is already in progress. Try again in a moment.",
      retryable: true,
    });
    return;
  }

  const crawlRow = await prisma.crawl.create({ data: { storeId: store.id, status: "RUNNING" } });

  onEvent({ type: "status", status: "shopify_detection" });

  let announcedCrawling = false;
  const crawlResult = await crawlShopifyStore(domain, {
    fetchImpl,
    dnsLookup,
    onProgress: (e) => {
      if (!announcedCrawling && e.phase === "fetching_products") {
        announcedCrawling = true;
        onEvent({ type: "status", status: "crawling" });
      }
      onEvent({ type: "progress", phase: e.phase, message: e.message, detail: e.detail });
    },
  });

  if (crawlResult.status !== "ok") {
    const { status, message } = classifyCrawlFailure(crawlResult);
    const failedAt = new Date();
    await prisma.crawl.update({
      where: { id: crawlRow.id },
      data: {
        status: crawlResult.status === "blocked" ? "BLOCKED" : "FAILED",
        finishedAt: failedAt,
        // Internal diagnostic detail stays in the database; the client gets
        // the curated message below, never this raw string.
        errorMessage: crawlResult.reason,
      },
    });
    // Same backoff/demotion path a scheduled crawl's failure takes — a
    // store that keeps failing manual analysis is exactly as unmonitorable
    // as one that keeps failing on a timer.
    await applyCrawlFailureToStore(prisma, store.id, failedAt);
    onEvent({ type: "error", status, message, retryable: status === "unreachable" });
    return;
  }

  const snapshot = normalizeSnapshot(crawlResult.input);

  if (snapshot.products.length === 0) {
    const failedAt = new Date();
    await prisma.crawl.update({
      where: { id: crawlRow.id },
      data: { status: "FAILED", finishedAt: failedAt, errorMessage: "zero products discovered", productCount: 0 },
    });
    await applyCrawlFailureToStore(prisma, store.id, failedAt);
    onEvent({
      type: "error",
      status: "crawl_incomplete",
      message:
        "The store is on Shopify, but its catalog didn't return enough readable data for a reliable report. This usually resolves on a retry.",
      retryable: true,
    });
    return;
  }

  onEvent({ type: "status", status: "persisting" });

  const outcome = await runDiffAndPersist({ prisma, storeId: store.id, crawlId: crawlRow.id, snapshot });

  if (outcome.result?.aborted) {
    onEvent({
      type: "error",
      status: "crawl_incomplete",
      message: "This crawl looked abnormal compared to what we've seen before and was not used.",
      retryable: true,
    });
    return;
  }

  // The authoritative entitlement gate: checked and recorded atomically
  // ONLY once the crawl has actually succeeded. This is deliberately after
  // the crawl, not before — a request that fails (unreachable, blocked,
  // rate-limited by the target store) must never burn one of a user's 3
  // lifetime credits on a report they never actually got. See
  // entitlements/analysis-usage.ts for the concurrency-safe accounting
  // (two simultaneous requests from a user with one credit left cannot
  // both succeed) — the pre-check above is just a fast-fail optimization,
  // this is the real gate.
  let alreadyAnalyzed = false;
  if (caller) {
    const usage = await recordAnalysisUsage(prisma, caller.userId, store.id, caller.plan);
    if (usage.outcome === "limit_reached") {
      emitLimitReached(onEvent);
      return;
    }
    alreadyAnalyzed = usage.outcome === "already_counted";
  }

  onEvent({ type: "status", status: "analyzing" });

  const report = await buildReport(prisma, store.id, domain, caller, alreadyAnalyzed);

  onEvent({ type: "status", status: "completed" });
  onEvent({ type: "complete", report });

  // Best-effort, after the user-facing stream has already delivered its
  // result — never blocks or delays what the caller sees. No-ops instantly
  // (zero external calls) on every crawl after the first for this store —
  // see enrichDomainAgeIfUnknown's own doc comment. A failure here must
  // never surface as an analysis failure; the crawl itself already fully
  // succeeded by this point.
  try {
    await enrichDomainAgeIfUnknown(prisma, store.id, domain, fetchImpl);
  } catch {
    // Swallowed deliberately — see comment above.
  }

  // Also best-effort and also never surfaces as an analysis failure — but,
  // unlike enrichDomainAgeIfUnknown, deliberately NOT "look up once, cache
  // forever": review counts genuinely change over time, so this attempts a
  // fresh, small, bounded sample on every crawl. See reviews/collect.ts.
  try {
    await collectStorefrontReviewObservations(prisma, store.id, domain, crawlRow.id, { fetchImpl, dnsLookup });
  } catch {
    // Swallowed deliberately — see comment above.
  }
}

function emitLimitReached(onEvent: (event: AnalysisSseEvent) => void): void {
  onEvent({
    type: "error",
    status: "analysis_limit_reached",
    message: "This analysis is unavailable.",
    retryable: false,
  });
}

function classifyCrawlFailure(
  result: Exclude<CrawlResult, { status: "ok" }>,
): { status: AnalysisStatus; message: string } {
  switch (result.status) {
    case "invalid":
      return { status: "invalid_url", message: "This URL can't be analyzed." };
    case "not_found":
      return {
        status: "non_shopify",
        message:
          "This doesn't appear to be a Shopify store. Bellwether currently analyzes Shopify storefronts only — support for more platforms is on the way.",
      };
    case "blocked":
      return {
        status: "unreachable",
        message:
          "This store didn't let us in — it may be password-protected or blocking automated access.",
      };
    case "error":
      return {
        status: "unreachable",
        message: "We couldn't reach this store. It may be temporarily down. Try again in a few minutes.",
      };
  }
}

async function buildReport(
  prisma: PrismaClient,
  storeId: string,
  domain: string,
  caller: { userId: string; plan: PlanTier } | null,
  alreadyAnalyzed: boolean,
): Promise<AnalysisReport> {
  if (!caller) {
    const [store, productCount] = await Promise.all([
      prisma.store.findUniqueOrThrow({ where: { id: storeId } }),
      prisma.product.count({ where: { storeId, status: "ACTIVE" } }),
    ]);
    return {
      access: "anonymous_preview",
      domain,
      platform: "shopify",
      productCount,
      theme: { name: store.themeName, version: store.themeVersion },
      checkedAt: new Date().toISOString(),
      cta: "Create a free account to unlock the complete store intelligence — full app stack, pricing, activity, and monitoring.",
    };
  }

  return buildFullStoreReport(prisma, storeId, domain, caller.userId, alreadyAnalyzed);
}

/**
 * The full report for an entitled, signed-in user — also reused as-is by
 * GET /api/store/[domain]/report so a user revisiting an already-analyzed
 * store gets identical data without a second implementation to drift out
 * of sync with this one.
 */
export async function buildFullStoreReport(
  prisma: PrismaClient,
  storeId: string,
  domain: string,
  userId: string,
  alreadyAnalyzed: boolean,
): Promise<FullStoreReport> {
  const [store, productCount, apps, pixels, paymentProviders, totalCrawls, avgPrice, usage] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: storeId } }),
    prisma.product.count({ where: { storeId, status: "ACTIVE" } }),
    prisma.storeEntity.findMany({
      where: { storeId, kind: "APP", status: "ACTIVE" },
      orderBy: { firstSeenAt: "asc" },
    }),
    prisma.storeEntity.findMany({
      where: { storeId, kind: "PIXEL", status: "ACTIVE" },
      orderBy: { firstSeenAt: "asc" },
    }),
    prisma.storeEntity.findMany({
      where: { storeId, kind: "PAYMENT_PROVIDER", status: "ACTIVE" },
      orderBy: { firstSeenAt: "asc" },
    }),
    prisma.crawl.count({ where: { storeId, status: { in: ["OK", "PARTIAL"] } } }),
    prisma.product.aggregate({ where: { storeId, status: "ACTIVE" }, _avg: { priceMinCents: true } }),
    getAnalysisUsage(prisma, userId),
  ]);

  return {
    access: "full",
    domain,
    platform: "shopify",
    checkedAt: new Date().toISOString(),
    productCount: { status: "OBSERVED", value: productCount },
    theme: { status: "OBSERVED", value: { name: store.themeName, version: store.themeVersion } },
    apps: { status: "OBSERVED", value: apps.map((a) => a.key) },
    pixels: { status: "OBSERVED", value: pixels.map((p) => p.key) },
    paymentProviders: { status: "OBSERVED", value: paymentProviders.map((p) => p.key) },
    averagePrice:
      avgPrice._avg.priceMinCents !== null
        ? { status: "OBSERVED", value: Math.round(avgPrice._avg.priceMinCents) }
        : unavailable("No active products to average"),
    // No validated revenue/traffic/review-velocity model exists yet — see
    // AGENTS.md / the Milestone 3 report. Genuinely unavailable, not a
    // paywalled tease: an authenticated user is entitled to see everything
    // currently supported, and this simply isn't built.
    revenue: permanentlyUnavailable("No validated revenue model implemented yet"),
    traffic: permanentlyUnavailable("No validated traffic estimation model implemented yet"),
    reviewVelocity: permanentlyUnavailable("Review history is not yet reliably collected"),
    monitoring: {
      tier: store.tier,
      active: store.tier !== "DISABLED",
      lastCrawledAt: store.lastCrawledAt?.toISOString() ?? null,
      nextCrawlAt: store.tier === "DISABLED" ? null : store.nextCrawlAt.toISOString(),
      totalCrawls,
    },
    entitlement: { analysesUsed: usage.used, analysesLimit: usage.limit, alreadyAnalyzed },
  };
}
