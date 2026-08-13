import type { PrismaClient } from "@prisma/client";
import { fetchProductPageHtml } from "../crawl/shopify";
import type { DnsLookup } from "../security/ssrf-guard";
import { extractReviewObservation } from "./jsonld-parser";
import { selectReviewSampleCandidates, type ReviewSampleCandidate } from "./sampling";

/**
 * Bounded, best-effort storefront JSON-LD review-count collection —
 * Milestone 9 Sub-phase E. Called after a crawl's own persistence has
 * already succeeded (same position/pattern as enrichment/domain-age.ts's
 * enrichDomainAgeIfUnknown), over an already-bounded, provider-aware sample
 * of already-persisted products — never a second crawl, never an unbounded
 * catalog walk.
 *
 * Unlike domain-age's "look up once, cache forever" idempotency, this runs
 * on every crawl by design: review counts genuinely change over time, and a
 * store's own history (delta since the previous observation) is the whole
 * point — see reviews/signal.ts.
 *
 * Never throws: one product's fetch/parse failure must never abort the rest
 * of the batch, and the whole function's failure must never fail the crawl
 * it's attached to (its callers additionally wrap this in try/catch, same
 * convention as enrichDomainAgeIfUnknown's own callers).
 */

const REQUEST_DELAY_MS = 250; // same politeness delay as crawl/shopify.ts's requestDelayMs default

type FetchLike = typeof fetch;

export interface CollectReviewObservationsOptions {
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
  userAgent?: string;
}

export interface CandidateOutcome {
  candidate: ReviewSampleCandidate;
  /** False when the page itself could not be read (blocked/not_found/error/thrown) — no row should ever be written for these. */
  wasRead: boolean;
  /** Null covers both "page unreadable" and "page read, no usable count found" — callers must check `wasRead` to tell those apart. */
  reviewCount: number | null;
  ratingValue: number | null;
}

/**
 * One candidate's full fetch+parse outcome. Exported separately from the
 * batch orchestrator below so it's unit-testable without a real Prisma
 * client or network — see __tests__/collect.test.ts.
 */
export async function fetchAndParseCandidate(
  domain: string,
  candidate: ReviewSampleCandidate,
  opts: CollectReviewObservationsOptions,
): Promise<CandidateOutcome> {
  try {
    const page = await fetchProductPageHtml(domain, candidate.handle, {
      fetchImpl: opts.fetchImpl,
      dnsLookup: opts.dnsLookup,
      userAgent: opts.userAgent,
    });
    if (page.status !== "ok") {
      // A fetch failure (blocked/not_found/error) is NOT a review-count
      // observation of any kind — never recorded as "0 reviews," and not
      // even recorded as a confident "sampled, absent" row, since we don't
      // actually know what the page would have contained.
      return { candidate, wasRead: false, reviewCount: null, ratingValue: null };
    }
    const parsed = extractReviewObservation(page.html, { handle: candidate.handle });
    if (parsed.status === "PRESENT") {
      return { candidate, wasRead: true, reviewCount: parsed.reviewCount, ratingValue: parsed.ratingValue };
    }
    // ABSENT / PRESENT_BUT_INVALID / AMBIGUOUS all mean the same thing to
    // the caller: the page WAS genuinely fetched and read, and no usable
    // review count could be confidently attributed to this product. This is
    // still worth recording (reviewCount: null, wasRead: true) — it's what
    // makes "sampled, no usable count" distinguishable from "never sampled"
    // at all, which is what makes coverage reporting (Step 11) honest.
    return { candidate, wasRead: true, reviewCount: null, ratingValue: null };
  } catch {
    // Fetch itself threw (network error, SSRF guard rejection, etc.) — same
    // treatment as a non-ok fetch result.
    return { candidate, wasRead: false, reviewCount: null, ratingValue: null };
  }
}

/**
 * Same-crawl, same-value cross-check (Milestone 9 Sub-phase D's confirmed
 * finding: sibling color/flavor variants can share one product-group-level
 * count). Deliberately NOT a deduplication algorithm — every observation is
 * still recorded individually; this only flags the ones sharing an exact
 * value within this one batch, so a future reader knows not to treat them as
 * independent. See Step 7: "DO NOT invent a deduplication algorithm."
 */
export function detectSharedCounts(outcomes: CandidateOutcome[]): Set<string> {
  const byCount = new Map<number, string[]>();
  for (const o of outcomes) {
    if (o.reviewCount === null) continue;
    const ids = byCount.get(o.reviewCount) ?? [];
    ids.push(o.candidate.id);
    byCount.set(o.reviewCount, ids);
  }
  const shared = new Set<string>();
  for (const ids of byCount.values()) {
    if (ids.length >= 2) ids.forEach((id) => shared.add(id));
  }
  return shared;
}

export async function collectStorefrontReviewObservations(
  prisma: PrismaClient,
  storeId: string,
  domain: string,
  crawlId: string,
  opts: CollectReviewObservationsOptions = {},
): Promise<void> {
  const { candidates, detectedProviders } = await selectReviewSampleCandidates(prisma, storeId);
  if (candidates.length === 0) return;

  const provider = detectedProviders[0] ?? null;

  const outcomes: CandidateOutcome[] = [];
  for (const candidate of candidates) {
    outcomes.push(await fetchAndParseCandidate(domain, candidate, opts));
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  const readOutcomes = outcomes.filter((o) => o.wasRead);
  const sharedIds = detectSharedCounts(readOutcomes);

  await Promise.all(
    readOutcomes.map((o) =>
      prisma.storefrontReviewObservation.upsert({
        where: { productId_crawlId: { productId: o.candidate.id, crawlId } },
        create: {
          productId: o.candidate.id,
          crawlId,
          reviewCount: o.reviewCount,
          ratingValue: o.ratingValue,
          provider,
          sharedWithGroup: sharedIds.has(o.candidate.id),
        },
        update: {
          reviewCount: o.reviewCount,
          ratingValue: o.ratingValue,
          provider,
          sharedWithGroup: sharedIds.has(o.candidate.id),
        },
      }),
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
