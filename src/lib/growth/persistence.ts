import type { PrismaClient } from "@prisma/client";

/**
 * How many times has a product actually been checked and found present?
 *
 * The wrong way to answer this: count `ProductStateSnapshot` rows. That table
 * is append-only-on-CHANGE (see schema.prisma), so a product whose price,
 * availability, and rank never move accumulates ZERO snapshot rows no matter
 * how many times it's been crawled — a perfectly stable bestseller would look
 * "never observed," while a product whose price jitters every crawl would
 * look maximally "persistent." That's backwards (see
 * docs/milestone-5-growth-signals-research.md Section 6.4, the pitfall this
 * module exists to fix).
 *
 * The right way: count real (OK/PARTIAL) crawls of the STORE, within a
 * bounded recent window, during which this product's status was ACTIVE.
 * Reconstructing "was it ACTIVE at crawl time T" needs two sources, not one:
 *
 *   1. `Product.missingSince` — set the instant a product first goes
 *      missing (engine.ts sets it at missingStreak 1, before REMOVED is ever
 *      confirmed), cleared only on restore. This precisely captures the
 *      CURRENT/ongoing gap, if the product is missing/removed right now.
 *   2. `PRODUCT_REMOVED` / `PRODUCT_RESTORED` events for this product —
 *      the only surviving record of a PAST gap that has since been resolved
 *      (a restored product's `missingSince` resets to null, so the current
 *      Product row alone can't tell you it was ever gone).
 *
 * Known, bounded imprecision: `PRODUCT_REMOVED` fires at *confirmation*
 * (after `removalConfirmations` consecutive misses — 2 by default), not at
 * the true start of that gap. A resolved past gap's first crawl or two may
 * therefore be counted as "active" when the product was in fact already
 * unseen. This is a small, honest approximation, not a fabrication — the
 * ongoing-gap case (1) has no such imprecision.
 *
 * CRITICAL: "crawl time" here means `Crawl.finishedAt`, never `startedAt`.
 * `missingSince`/`firstSeenAt` and every lifecycle event's `occurredAt` are
 * all written from the exact same `now` value used to set that crawl's
 * `finishedAt` (see diff/persist.ts — `runDiffAndPersist`'s `now` is shared
 * by the Crawl update and every Product/Event write inside the same
 * transaction; run-scheduled-crawl.ts captures `now` once, before the crawl
 * even starts, and threads that identical value through to `finishedAt` too).
 * `startedAt`, by contrast, is set separately — at crawl-row creation, before
 * the storefront fetch even begins — so it is always strictly earlier than
 * that same crawl's own `finishedAt`/`missingSince`/event timestamps by
 * however long the crawl took to run. Comparing `startedAt` against
 * `missingSince`/`occurredAt` (an earlier version of this module did exactly
 * that) silently misclassifies the ONE crawl that actually discovered a
 * transition: the crawl where a product first went missing would still count
 * as "active" for that crawl, and the crawl where a product was restored
 * would still count as "inactive" for that crawl — the exact boundary crawl
 * always lands on the wrong side. `finishedAt` and `missingSince`/`occurredAt`
 * share the same instant, so the `>=`/`<=` comparisons below resolve exactly
 * at the crawl that caused them.
 */

export const PERSISTENCE_WINDOW_CRAWLS = 20;
export const MIN_CRAWLS_FOR_PERSISTENCE = 3;
const MAX_TRANSITION_EVENTS = 50;

const TRANSITION_TYPES = ["PRODUCT_REMOVED", "PRODUCT_RESTORED"] as const;
export type LifecycleTransitionType = (typeof TRANSITION_TYPES)[number];

export interface LifecycleTransition {
  type: LifecycleTransitionType;
  occurredAt: Date;
}

export interface PersistenceInsufficientHistory {
  status: "INSUFFICIENT_HISTORY";
  /** Real crawls found at or after this product's firstSeenAt — below MIN_CRAWLS_FOR_PERSISTENCE. */
  realCrawlsAvailable: number;
  /**
   * Total real crawls found for the STORE within the window (before
   * filtering by this product's firstSeenAt) — lets a caller distinguish
   * "the store itself barely has any history yet" from "the store has
   * plenty of history, this particular product is just newly discovered."
   * See freshness.ts, which uses exactly this distinction.
   */
  storeRealCrawlCount: number;
}

export interface PersistenceObserved {
  status: "OBSERVED";
  /** Real crawls in the window where this product was verified ACTIVE. */
  observedActiveCount: number;
  /** Real crawls in the window since this product's firstSeenAt — the denominator. */
  windowCrawlCount: number;
  /** observedActiveCount / windowCrawlCount, 0..1. */
  ratio: number;
  windowStart: Date;
  windowEnd: Date;
}

export type PersistenceResult = PersistenceInsufficientHistory | PersistenceObserved;

export interface ComputePersistenceArgs {
  /** Real (OK/PARTIAL) crawl FINISH times (never startedAt — see module doc) for the store, most-recent-first, already capped to PERSISTENCE_WINDOW_CRAWLS. */
  recentCrawls: Date[];
  firstSeenAt: Date;
  currentMissingSince: Date | null;
  currentStatus: "ACTIVE" | "MISSING" | "REMOVED";
  /** This product's REMOVED/RESTORED events with occurredAt >= the oldest crawl below, ascending, already capped. */
  transitionsInWindow: LifecycleTransition[];
  /** The most recent REMOVED/RESTORED event strictly before the window, if any — establishes the state the product was in when the window opened. */
  transitionBeforeWindow: LifecycleTransition | null;
}

/**
 * PURE. No Prisma, no clock reads — every input is already fetched and
 * bounded by the caller (getProductPersistence below). Deterministic
 * simulation: walk the window's real crawls in chronological order, applying
 * lifecycle transitions as they're crossed, with the current ongoing-gap
 * override taking precedence at the tail end.
 */
export function computePersistence(args: ComputePersistenceArgs): PersistenceResult {
  const { firstSeenAt, currentMissingSince, currentStatus, transitionBeforeWindow } = args;

  const qualifyingCrawls = args.recentCrawls
    .filter((t) => t.getTime() >= firstSeenAt.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  if (qualifyingCrawls.length < MIN_CRAWLS_FOR_PERSISTENCE) {
    return {
      status: "INSUFFICIENT_HISTORY",
      realCrawlsAvailable: qualifyingCrawls.length,
      storeRealCrawlCount: args.recentCrawls.length,
    };
  }

  const transitions = [...args.transitionsInWindow].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  let state: "ACTIVE" | "INACTIVE" = transitionBeforeWindow?.type === "PRODUCT_REMOVED" ? "INACTIVE" : "ACTIVE";
  let transitionIndex = 0;
  let observedActiveCount = 0;

  for (const crawlTime of qualifyingCrawls) {
    while (transitionIndex < transitions.length && transitions[transitionIndex].occurredAt.getTime() <= crawlTime.getTime()) {
      state = transitions[transitionIndex].type === "PRODUCT_REMOVED" ? "INACTIVE" : "ACTIVE";
      transitionIndex++;
    }

    // The ongoing-gap override: if the product is missing/removed right now,
    // every crawl at or after the current missingSince is excluded even if
    // no PRODUCT_REMOVED event has fired yet (streak 1, pre-confirmation).
    const forcedInactive =
      currentStatus !== "ACTIVE" && currentMissingSince !== null && crawlTime.getTime() >= currentMissingSince.getTime();

    if (state === "ACTIVE" && !forcedInactive) observedActiveCount++;
  }

  return {
    status: "OBSERVED",
    observedActiveCount,
    windowCrawlCount: qualifyingCrawls.length,
    ratio: observedActiveCount / qualifyingCrawls.length,
    windowStart: qualifyingCrawls[0],
    windowEnd: qualifyingCrawls[qualifyingCrawls.length - 1],
  };
}

export interface PersistenceProductInput {
  externalId: string;
  firstSeenAt: Date;
  missingSince: Date | null;
  status: "ACTIVE" | "MISSING" | "REMOVED";
}

/**
 * Three bounded, indexed queries — never a scan of a product's full lifetime:
 *   1. Last PERSISTENCE_WINDOW_CRAWLS real crawls for the store, ordered by
 *      `finishedAt` (see module doc for why `startedAt` is wrong here) —
 *      still served by the existing `[storeId, startedAt DESC]` index for
 *      the `storeId` prefix; Postgres sorts the per-store row set (bounded
 *      by `take`) by `finishedAt` itself, confirmed cheap at real scale
 *      (see the completion report's query-cost audit).
 *   2. This product's lifecycle transitions inside that window
 *      ([storeId, entityType, entityKey, occurredAt DESC] — added
 *      Sub-phase B specifically for this and bestseller.ts).
 *   3. A single point-lookup for the transition immediately before the
 *      window, to know the state the window opened in.
 */
export async function getProductPersistence(
  prisma: PrismaClient,
  storeId: string,
  product: PersistenceProductInput,
  now: Date = new Date(),
): Promise<PersistenceResult> {
  void now; // reserved for callers that want to pin "now" in tests; queries below are relative to real crawl rows, not the clock

  const recentCrawlRows = await prisma.crawl.findMany({
    where: { storeId, status: { in: ["OK", "PARTIAL"] }, finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: PERSISTENCE_WINDOW_CRAWLS,
    select: { finishedAt: true },
  });

  if (recentCrawlRows.length === 0) {
    return { status: "INSUFFICIENT_HISTORY", realCrawlsAvailable: 0, storeRealCrawlCount: 0 };
  }

  // finishedAt is guaranteed non-null by the where clause above — every OK/
  // PARTIAL crawl sets it in the same write that sets status (persist.ts) —
  // this map is just satisfying TypeScript, not defending against real nulls.
  const recentCrawls = recentCrawlRows.map((c) => c.finishedAt as Date);
  const windowStart = recentCrawls[recentCrawls.length - 1];

  const [transitionsInWindowRows, transitionBeforeWindowRow] = await Promise.all([
    prisma.event.findMany({
      where: {
        storeId,
        entityType: "PRODUCT",
        entityKey: product.externalId,
        eventType: { in: [...TRANSITION_TYPES] },
        occurredAt: { gte: windowStart },
      },
      orderBy: { occurredAt: "asc" },
      take: MAX_TRANSITION_EVENTS,
      select: { eventType: true, occurredAt: true },
    }),
    prisma.event.findFirst({
      where: {
        storeId,
        entityType: "PRODUCT",
        entityKey: product.externalId,
        eventType: { in: [...TRANSITION_TYPES] },
        occurredAt: { lt: windowStart },
      },
      orderBy: { occurredAt: "desc" },
      select: { eventType: true, occurredAt: true },
    }),
  ]);

  return computePersistence({
    recentCrawls,
    firstSeenAt: product.firstSeenAt,
    currentMissingSince: product.missingSince,
    currentStatus: product.status,
    transitionsInWindow: transitionsInWindowRows.map((e) => ({
      type: e.eventType as LifecycleTransitionType,
      occurredAt: e.occurredAt,
    })),
    transitionBeforeWindow: transitionBeforeWindowRow
      ? { type: transitionBeforeWindowRow.eventType as LifecycleTransitionType, occurredAt: transitionBeforeWindowRow.occurredAt }
      : null,
  });
}
