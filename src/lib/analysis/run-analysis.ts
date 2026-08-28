import type { PrismaClient } from "@prisma/client";
import { canonicalizeDomain, crawlShopifyStore, type CrawlResult } from "../crawl/shopify";
import { normalizeSnapshot } from "../crawl/normalize";
import { runDiffAndPersist } from "../diff/persist";
import type { DnsLookup } from "../security/ssrf-guard";
import { applyCrawlFailureToStore } from "../monitoring/crawl-outcome";
import { getAnalysisUsage, hasAnalyzedStoreInWindow, recordAnalysisUsage } from "../entitlements/analysis-usage";
import { isUnderLimit } from "../entitlements/plan-limits";
import type { PlanTier } from "../entitlements/plan-limits";
import { limitReached } from "../entitlements/limit-reached";
import { permanentlyUnavailable, unavailable } from "./report-contract";
import { enrichDomainAgeIfUnknown } from "../enrichment/domain-age";
import { collectStorefrontReviewObservations } from "../reviews/collect";
import type { AnalysisSseEvent, AnalysisStatus, FullStoreReport } from "./types";

/**
 * Orchestrates one product-facing "analyze this store" request for a
 * SIGNED-IN, entitled caller: validate, crawl, persist (via the existing
 * engine), and hand back the full report. This is the ONE place that
 * decides what a browser is allowed to see — buildFullStoreReport() below
 * is the entire contract, not a filter applied later.
 *
 * Milestone 12 §1.3 (D3 amendment): anonymous callers no longer reach this
 * function at all — `caller` is required. They get a genuinely different,
 * much cheaper operation instead (analysis/anonymous-probe.ts's
 * runAnonymousProbe(): one request, no pagination, no enrichment, no Store
 * row), not a branch of this one. Before this milestone `caller` was
 * nullable and an anonymous call ran the SAME full multi-request crawl as a
 * signed-in one, just without spending a credit — that was only ever
 * reachable in tests (Milestone 11 fix 1.4 already required auth at the
 * route level), and D3 replaces it outright rather than preserving it as
 * dead capability.
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
  caller: { userId: string; plan: PlanTier };
}

/** A RUNNING crawl older than this is treated as abandoned, not a live duplicate. */
const DEDUP_WINDOW_MS = 2 * 60_000;

export async function runAnalysis(args: RunAnalysisArgs): Promise<void> {
  const { prisma, urlInput, onEvent, fetchImpl, dnsLookup, caller } = args;

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

  // Deliberately a lookup, not an upsert: creating the Store row here —
  // before the crawl has even proven this domain is a real, reachable
  // Shopify store — was a real bug (this milestone's doc, item 1.5).
  // Store.tier defaults to COLD and nextCrawlAt to now(), so every junk
  // domain (typos, non-Shopify sites, dead domains) immediately entered the
  // scheduler's due-query and stayed there forever. The Store row is now
  // created ONLY after crawlShopifyStore returns status: "ok", below.
  const existingStore = await prisma.store.findUnique({ where: { domain }, select: { id: true } });

  // Entitlement pre-check: cheap and read-only, purely to fail fast for a
  // caller who's obviously already at their limit — a request that's going
  // to be rejected regardless shouldn't cost a real fetch against someone's
  // storefront. This is NOT the authoritative gate (see below): it only
  // reads, it never records, so it introduces no race condition to worry
  // about. A domain with no Store row yet has never been analyzed by
  // ANYONE, so "already analyzed by THIS user in the current window" is
  // trivially false — skip the store-specific lookup (there's no store.id
  // to check against) and compare the user's raw usage count directly
  // instead. Uses the WINDOWED variant, not the permanent hasAnalyzedStore:
  // under D2, a store analyzed outside the current 24h window is due a
  // fresh credit on re-analysis, so the all-time version would wrongly
  // treat an over-quota caller's stale revisit as free and skip this check.
  const analyzedInWindow = existingStore ? await hasAnalyzedStoreInWindow(prisma, caller.userId, existingStore.id) : false;
  if (!analyzedInWindow) {
    const usage = await getAnalysisUsage(prisma, caller.userId);
    if (!isUnderLimit(usage.used, usage.limit)) {
      // isUnderLimit(count, null) is always true, so reaching this branch guarantees usage.limit !== null.
      emitLimitReached(onEvent, usage.used, usage.limit as number, usage.resetsAt, caller.plan);
      return;
    }
  }

  // Dedup: only meaningful when a Store row already exists — a domain with
  // none can't possibly have an in-flight crawl to collide with. This also
  // means a brand-new domain's Crawl row (created below, only after a
  // successful detection) can't yet serve as a RUNNING marker during the
  // crawl itself — an accepted, narrow race (two simultaneous first-ever
  // requests for the exact same never-seen domain) traded for never writing
  // a Store/Crawl row for a domain that turns out not to be Shopify at all.
  let crawlRow: { id: string } | null = null;
  if (existingStore) {
    const recentRunning = await prisma.crawl.findFirst({
      where: { storeId: existingStore.id, status: "RUNNING", startedAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) } },
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
    crawlRow = await prisma.crawl.create({ data: { storeId: existingStore.id, status: "RUNNING" } });
  }

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
    // Only a store that already existed (and therefore already has a
    // RUNNING Crawl row from above) gets its failure recorded — a brand-new
    // domain that fails detection leaves zero Store/Crawl rows behind,
    // by design.
    if (existingStore && crawlRow) {
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
      await applyCrawlFailureToStore(prisma, existingStore.id, failedAt);
    }
    onEvent({ type: "error", status, message, retryable: status === "unreachable" });
    return;
  }

  // Crawl succeeded — NOW it's safe to create the Store row for a brand-new
  // domain. upsert() is still idempotent/correct for an already-existing
  // one (a plain create() would conflict on the unique domain).
  const store =
    existingStore ??
    (await prisma.store.upsert({
      where: { domain },
      create: { domain, platform: "SHOPIFY" },
      update: {},
      select: { id: true },
    }));
  if (!crawlRow) {
    crawlRow = await prisma.crawl.create({ data: { storeId: store.id, status: "RUNNING" } });
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
  // rate-limited by the target store) must never burn one of a user's daily
  // credits on a report they never actually got. See
  // entitlements/analysis-usage.ts for the concurrency-safe accounting
  // (two simultaneous requests from a user with one credit left cannot
  // both succeed) — the pre-check above is just a fast-fail optimization,
  // this is the real gate.
  const usage = await recordAnalysisUsage(prisma, caller.userId, store.id, caller.plan);
  if (usage.outcome === "limit_reached") {
    emitLimitReached(onEvent, usage.current, usage.max, usage.resetsAt, caller.plan);
    return;
  }
  const alreadyAnalyzed = usage.outcome === "already_counted";

  onEvent({ type: "status", status: "analyzing" });

  const report = await buildFullStoreReport(prisma, store.id, domain, caller.userId, alreadyAnalyzed);

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

function emitLimitReached(
  onEvent: (event: AnalysisSseEvent) => void,
  current: number,
  max: number,
  resetsAt: Date | null,
  plan: PlanTier,
): void {
  onEvent({
    type: "error",
    status: "analysis_limit_reached",
    message: `You've reached your limit of ${max} analyses in 24 hours. Upgrade for a higher daily limit.`,
    retryable: false,
    limitReached: limitReached({ limit: "ANALYSES_PER_DAY", current, max, resetsAt, plan }),
  });
}

/** Exported for analysis/anonymous-probe.ts — the shallow probe's failure shape is the identical Exclude<CrawlResult, {status:"ok"}> union, so it reuses this classification rather than a second copy. */
export function classifyCrawlFailure(
  result: Exclude<CrawlResult, { status: "ok" }>,
): { status: AnalysisStatus; message: string } {
  switch (result.status) {
    case "invalid":
      return { status: "invalid_url", message: "This URL can't be analyzed." };
    case "not_found":
      return {
        status: "non_shopify",
        message:
          "This doesn't appear to be a Shopify store. We currently analyze Shopify storefronts only — support for more platforms is on the way.",
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
    entitlement: {
      analysesUsed: usage.used,
      analysesLimit: usage.limit,
      resetsAt: usage.resetsAt?.toISOString() ?? null,
      alreadyAnalyzed,
    },
  };
}
