import type { PrismaClient } from "@prisma/client";
import { canonicalizeDomain, probeShopifyStorePage1 } from "../crawl/shopify";
import type { DnsLookup } from "../security/ssrf-guard";
import { verifyTurnstileToken } from "../security/turnstile";
import { recordAnonymousAnalysis } from "../entitlements/anonymous-analysis";
import { classifyCrawlFailure } from "./run-analysis";
import type { AnalysisSseEvent } from "./types";

/**
 * Milestone 12 §1.3 (D3 amendment): the anonymous counterpart to
 * run-analysis.ts's runAnalysis() — genuinely different, not a branch of
 * it. An anonymous caller gets exactly one outbound request (products.json
 * page 1, via probeShopifyStorePage1()), no pagination, no bestseller/
 * collection/homepage extras, no review sampling, and — the fix 1.5
 * invariant this milestone explicitly preserves — no Store row, ever. There
 * is nothing here for enrichDomainAgeIfUnknown() or
 * collectStorefrontReviewObservations() to run against, since neither a
 * Store nor a Crawl row exists to attach their results to.
 */

type FetchLike = typeof fetch;

export interface RunAnonymousProbeArgs {
  prisma: PrismaClient;
  urlInput: string;
  /** getClientIp()'s output (Milestone 11 fix 1.1) — never the raw x-forwarded-for header. */
  ipKey: string;
  turnstileToken: string | null;
  onEvent: (event: AnalysisSseEvent) => void;
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
  hourlyCeiling: number;
  /** Injectable for tests — defaults to the real Cloudflare siteverify call. */
  verifyTurnstile?: typeof verifyTurnstileToken;
}

export async function runAnonymousProbe(args: RunAnonymousProbeArgs): Promise<void> {
  const { prisma, urlInput, ipKey, turnstileToken, onEvent, fetchImpl, dnsLookup, hourlyCeiling } = args;
  const verify = args.verifyTurnstile ?? verifyTurnstileToken;

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

  // Fail closed, before any outbound fetch or database write — per D3, "no
  // token, no crawl."
  const verification = await verify(turnstileToken, { fetchImpl });
  if (!verification.ok) {
    onEvent({
      type: "error",
      status: "turnstile_failed",
      message: "We couldn't verify you're human. Please try again.",
      retryable: true,
    });
    return;
  }

  // Recorded BEFORE the fetch, unlike the authenticated path's
  // record-after-success pattern (run-analysis.ts's own comment on why that
  // ordering matters there): the circuit breaker's own contract is a count
  // of crawls STARTED in the last hour, and a shallow probe is cheap enough
  // (one request) that "don't waste a slot on a failure" isn't worth
  // letting an attacker retry an always-failing domain for free forever.
  const usage = await recordAnonymousAnalysis(prisma, ipKey, domain, hourlyCeiling);
  if (usage.outcome === "circuit_open") {
    onEvent({
      type: "error",
      status: "service_unavailable",
      message: "Anonymous analysis is temporarily unavailable due to high demand. Please try again shortly, or sign in.",
      retryable: true,
    });
    return;
  }
  if (usage.outcome === "limit_reached") {
    onEvent({
      type: "error",
      status: "anonymous_limit_reached",
      message: "You've used all 3 free analyses for today. Sign in for more.",
      retryable: false,
    });
    return;
  }

  onEvent({ type: "status", status: "shopify_detection" });

  const result = await probeShopifyStorePage1(domain, { fetchImpl, dnsLookup });

  if (result.status !== "ok") {
    const { status, message } = classifyCrawlFailure(result);
    onEvent({ type: "error", status, message, retryable: status === "unreachable" });
    return;
  }

  onEvent({ type: "status", status: "completed" });
  onEvent({
    type: "complete",
    report: {
      access: "anonymous_probe",
      domain,
      platform: "shopify",
      productCount: result.productCount,
      priceRange: { minCents: result.priceMinCents, maxCents: result.priceMaxCents },
      checkedAt: new Date().toISOString(),
      cta: "Create a free account to unlock the complete store intelligence — full app stack, pricing, activity, and monitoring.",
    },
  });
}
