import { formatCents, pctChange } from "../money";
import type {
  NormalizedProduct,
  NormalizedStoreSnapshot,
  PreviousProductState,
  StoreContext,
} from "../crawl/types";
import {
  DEFAULT_DIFF_CONFIG,
  dayBucket,
  makeDedupeKey,
  type DiffConfig,
  type DraftEvent,
  type EventType,
} from "./events";
import { diffEntitySet, observeEntities, type EntityUpsert } from "./entities";
import { priceMagnitude, rankMagnitude, scoreEvent } from "./significance";

/**
 * PURE. No Prisma, no fetch, no clock reads beyond the injected `now`.
 * Everything here is a deterministic function of its inputs, which is the only
 * reason this logic is testable at all — and diff logic you cannot test will
 * quietly ship false positives to paying customers for months.
 */

export interface ProductUpsert {
  externalId: string;
  productId: string | null; // null = insert
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  sourceCreatedAt: Date | null;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  missingStreak: number;
  missingSince: Date | null;
  priceMinCents: number;
  priceMaxCents: number;
  compareAtMaxCents: number | null;
  variantCount: number;
  availableVariants: number;
  bestsellerRank: number | null;
  imageHash: string | null;
  lastSeenAt: Date | null;
  /** Write a ProductStateSnapshot row only when true. Keeps storage ~95% down. */
  stateChanged: boolean;
}

export interface DiffResult {
  aborted: boolean;
  abortReason: string | null;
  isBaseline: boolean;

  events: DraftEvent[];
  /** Alertable events dropped because the store did a bulk operation. */
  suppressedCount: number;

  upserts: ProductUpsert[];
  entityUpserts: EntityUpsert[];
  catalogChanged: boolean;

  storePatch: {
    themeName?: string | null;
    themeVersion?: string | null;
  };
}

export interface DiffInput {
  store: StoreContext;
  previous: PreviousProductState[];
  snapshot: NormalizedStoreSnapshot;
  now: Date;
  config?: Partial<DiffConfig>;
  /** externalId -> how many other stores made the same move this week. */
  crossStoreCounts?: Map<string, number>;
}

export function diffStore(input: DiffInput): DiffResult {
  const cfg = { ...DEFAULT_DIFF_CONFIG, ...(input.config ?? {}) };
  const { store, snapshot, now } = input;
  const crossStore = input.crossStoreCounts ?? new Map<string, number>();

  const result: DiffResult = {
    aborted: false,
    abortReason: null,
    isBaseline: store.baselinedAt === null,
    events: [],
    suppressedCount: 0,
    upserts: [],
    entityUpserts: [],
    catalogChanged: false,
    storePatch: {},
  };

  const prevByExternalId = new Map(input.previous.map((p) => [p.externalId, p]));
  const seenExternalIds = new Set(snapshot.products.map((p) => p.externalId));
  const previouslyActive = input.previous.filter((p) => p.status !== "REMOVED");

  // -------------------------------------------------------------------------
  // GUARD 1 — catalog shrink circuit breaker.
  //
  // The single most damaging failure mode in this system is a silent partial
  // crawl being read as a mass discontinuation. If the catalog appears to have
  // collapsed, we refuse to diff at all rather than emit 200 wrong alerts.
  // -------------------------------------------------------------------------
  if (previouslyActive.length >= cfg.minProductsForShrinkCheck) {
    const ratio = snapshot.products.length / previouslyActive.length;
    if (ratio < 1 - cfg.maxCatalogShrinkRatio) {
      return {
        ...result,
        aborted: true,
        abortReason:
          `catalog shrank from ${previouslyActive.length} to ${snapshot.products.length} ` +
          `(${Math.round(ratio * 100)}%) — treating as failed crawl, not mass removal`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // BASELINE — first successful crawl of this store.
  //
  // Emit NO alertable events; 250 "new product!" notifications on day one is
  // how you get muted. Instead, reconstruct the launch timeline retroactively
  // from the platform's own created_at. Those events are flagged backfilled:
  // they power charts and never trigger alerts.
  // -------------------------------------------------------------------------
  if (result.isBaseline) {
    result.events.push(
      draft({
        entityType: "STORE",
        entityKey: store.domain,
        eventType: "STORE_BASELINED",
        oldValue: null,
        newValue: { productCount: snapshot.products.length },
        headline: `Started tracking ${store.domain} (${snapshot.products.length} products)`,
        significance: 5,
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: dayBucket(now),
      }),
    );

    for (const p of snapshot.products) {
      if (!p.sourceCreatedAt) continue;
      result.events.push(
        draft({
          entityType: "PRODUCT",
          entityKey: p.externalId,
          eventType: "PRODUCT_ADDED",
          oldValue: null,
          newValue: { title: p.title, priceCents: p.priceMinCents },
          headline: `${p.title} added`,
          significance: 20,
          backfilled: true,
          occurredAt: p.sourceCreatedAt,
          storeId: store.id,
          discriminator: p.sourceCreatedAt.toISOString(),
        }),
      );
    }

    result.upserts = snapshot.products.map((p) => toUpsert(p, null, now, true));
    result.catalogChanged = true;
    result.storePatch = techPatch(snapshot);

    // Entities need this call on baseline too, even though isBaseline
    // suppresses their events same as products: skip it here and the first
    // crawl never persists a single app/pixel/collection row, so the
    // *second* crawl sees an empty "previous" set and fires everything as
    // newly added — the exact bug this file exists to fix, one crawl later.
    const { observed, observedKinds } = observeEntities(snapshot);
    result.entityUpserts = diffEntitySet({
      store,
      previous: store.entities,
      observed,
      observedKinds,
      now,
      isBaseline: true,
      removalConfirmations: cfg.removalConfirmations,
    }).upserts;

    return result;
  }

  // -------------------------------------------------------------------------
  // PRODUCT-LEVEL DIFF
  // -------------------------------------------------------------------------
  const alertable: DraftEvent[] = [];

  for (const p of snapshot.products) {
    const prev = prevByExternalId.get(p.externalId);

    // --- NEW or RESTORED ---------------------------------------------------
    if (!prev) {
      result.upserts.push(toUpsert(p, null, now, true));
      alertable.push(
        draft({
          entityType: "PRODUCT",
          entityKey: p.externalId,
          eventType: "PRODUCT_ADDED",
          oldValue: null,
          newValue: { title: p.title, priceCents: p.priceMinCents, handle: p.handle },
          headline: `New product: ${p.title} at ${formatCents(p.priceMinCents, store.currency)}`,
          significance: scoreEvent({
            eventType: "PRODUCT_ADDED",
            store,
            magnitude: 0.6,
            bestsellerRank: p.bestsellerRank,
            priceCents: p.priceMinCents,
            crossStoreCount: crossStore.get(p.externalId),
          }),
          backfilled: false,
          occurredAt: now,
          storeId: store.id,
          discriminator: p.externalId,
        }),
      );
      continue;
    }

    if (prev.status !== "ACTIVE") {
      alertable.push(
        draft({
          entityType: "PRODUCT",
          entityKey: p.externalId,
          eventType: "PRODUCT_RESTORED",
          oldValue: { status: prev.status },
          newValue: { status: "ACTIVE", priceCents: p.priceMinCents },
          headline: `${p.title} is back in the catalog`,
          significance: scoreEvent({
            eventType: "PRODUCT_RESTORED",
            store,
            magnitude: 0.5,
            bestsellerRank: p.bestsellerRank,
            priceCents: p.priceMinCents,
          }),
          backfilled: false,
          occurredAt: now,
          storeId: store.id,
          discriminator: `${p.externalId}:${dayBucket(now)}`,
        }),
      );
    }

    // --- PRICE -------------------------------------------------------------
    const priceEvents = diffPrice(p, prev, store, cfg, now, crossStore);
    alertable.push(...priceEvents);

    // --- AVAILABILITY ------------------------------------------------------
    alertable.push(...diffAvailability(p, prev, store, now));

    // --- BESTSELLER RANK ---------------------------------------------------
    if (snapshot.hasRankData) {
      alertable.push(...diffRank(p, prev, store, cfg, now));
    }

    const changed =
      prev.priceMinCents !== p.priceMinCents ||
      prev.priceMaxCents !== p.priceMaxCents ||
      prev.compareAtMaxCents !== p.compareAtMaxCents ||
      prev.variantCount !== p.variantCount ||
      prev.availableVariants !== p.availableVariants ||
      prev.status !== "ACTIVE" ||
      (snapshot.hasRankData && prev.bestsellerRank !== p.bestsellerRank);

    result.upserts.push(toUpsert(p, prev, now, changed));
  }

  // -------------------------------------------------------------------------
  // REMOVALS — state machine, never a single-crawl decision.
  //
  // ACTIVE -> MISSING (streak 1) -> MISSING (streak 2) -> REMOVED
  //
  // GUARD 2: on a partial crawl, absence proves nothing. Skip entirely and
  // leave streaks untouched so a flaky request cannot advance the machine.
  // -------------------------------------------------------------------------
  if (!snapshot.partial) {
    for (const prev of previouslyActive) {
      if (seenExternalIds.has(prev.externalId)) continue;

      const streak = prev.missingStreak + 1;
      const confirmed = streak >= cfg.removalConfirmations;

      result.upserts.push({
        externalId: prev.externalId,
        productId: prev.id,
        handle: prev.handle,
        title: prev.title,
        vendor: null,
        productType: null,
        tags: [],
        sourceCreatedAt: null,
        status: confirmed ? "REMOVED" : "MISSING",
        missingStreak: streak,
        missingSince: prev.missingSince ?? now,
        priceMinCents: prev.priceMinCents,
        priceMaxCents: prev.priceMaxCents,
        compareAtMaxCents: prev.compareAtMaxCents,
        variantCount: prev.variantCount,
        availableVariants: 0,
        bestsellerRank: null,
        imageHash: null,
        lastSeenAt: null, // deliberately not touched — it means "last seen"
        stateChanged: true,
      });

      if (confirmed && prev.status !== "REMOVED") {
        alertable.push(
          draft({
            entityType: "PRODUCT",
            entityKey: prev.externalId,
            eventType: "PRODUCT_REMOVED",
            oldValue: { title: prev.title, priceCents: prev.priceMinCents },
            newValue: null,
            headline: `${prev.title} discontinued`,
            significance: scoreEvent({
              eventType: "PRODUCT_REMOVED",
              store,
              magnitude: 0.6,
              bestsellerRank: prev.bestsellerRank,
              priceCents: prev.priceMinCents,
            }),
            backfilled: false,
            occurredAt: now,
            storeId: store.id,
            discriminator: prev.externalId,
          }),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // STORE-LEVEL: theme (scalar — a value change, not set membership) plus
  // apps/pixels/collections/payment providers (set membership — diffEntitySet
  // carries the same MISSING->REMOVED confirmation guard products get, which
  // is what stops flappy fingerprinting from firing REMOVED then ADDED on
  // every single crawl).
  // -------------------------------------------------------------------------
  alertable.push(...diffTech(snapshot, store, now));

  const { observed, observedKinds } = observeEntities(snapshot);
  const entityDiff = diffEntitySet({
    store,
    previous: store.entities,
    observed,
    observedKinds,
    now,
    isBaseline: false,
    removalConfirmations: cfg.removalConfirmations,
  });
  alertable.push(...entityDiff.events);
  result.entityUpserts = entityDiff.upserts;

  result.storePatch = techPatch(snapshot);

  // -------------------------------------------------------------------------
  // GUARD 3 — bulk-operation suppression.
  //
  // A store rotating out 80 seasonal SKUs is one fact, not 80 alerts. Past the
  // cap we keep the highest-significance events and report the remainder as a
  // count for the digest to summarise.
  // -------------------------------------------------------------------------
  alertable.sort((a, b) => b.significance - a.significance);
  if (alertable.length > cfg.maxEventsPerCrawl) {
    result.suppressedCount = alertable.length - cfg.maxEventsPerCrawl;
    alertable.length = cfg.maxEventsPerCrawl;
  }

  result.events.push(...alertable);
  result.catalogChanged = result.upserts.some((u) => u.stateChanged);
  return result;
}

// ---------------------------------------------------------------------------
// Sub-diffs
// ---------------------------------------------------------------------------

function diffPrice(
  p: NormalizedProduct,
  prev: PreviousProductState,
  store: StoreContext,
  cfg: DiffConfig,
  now: Date,
  crossStore: Map<string, number>,
): DraftEvent[] {
  const events: DraftEvent[] = [];

  const oldPrice = prev.priceMinCents;
  const newPrice = p.priceMinCents;
  const delta = newPrice - oldPrice;
  const pct = pctChange(oldPrice, newPrice);

  const hadCompareAt = (prev.compareAtMaxCents ?? 0) > 0;
  const hasCompareAt = (p.compareAtMaxCents ?? 0) > 0;

  // Sale lifecycle is tracked separately from repositioning. "Went on sale"
  // and "permanently repriced" are different intelligence and must not merge.
  if (!hadCompareAt && hasCompareAt && delta < 0) {
    const discountPct = pctChange(p.compareAtMaxCents!, newPrice) ?? 0;
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "SALE_STARTED",
        oldValue: { priceCents: oldPrice },
        newValue: { priceCents: newPrice, compareAtCents: p.compareAtMaxCents },
        headline: `${p.title} on sale: ${formatCents(newPrice, store.currency)} (${Math.round(Math.abs(discountPct) * 100)}% off)`,
        significance: scoreEvent({
          eventType: "SALE_STARTED",
          store,
          magnitude: priceMagnitude(discountPct),
          bestsellerRank: p.bestsellerRank,
          priceCents: newPrice,
          crossStoreCount: crossStore.get(p.externalId),
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${newPrice}`,
      }),
    );
    return events;
  }

  if (hadCompareAt && !hasCompareAt && delta > 0) {
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "SALE_ENDED",
        oldValue: { priceCents: oldPrice },
        newValue: { priceCents: newPrice },
        headline: `${p.title} back to ${formatCents(newPrice, store.currency)}`,
        significance: scoreEvent({
          eventType: "SALE_ENDED",
          store,
          magnitude: 0.4,
          bestsellerRank: p.bestsellerRank,
          priceCents: newPrice,
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${newPrice}`,
      }),
    );
    return events;
  }

  // Noise floor: must clear BOTH thresholds. Percentage alone spams on cheap
  // items; absolute alone spams on expensive ones.
  if (delta === 0 || pct === null) return events;
  if (Math.abs(pct) < cfg.minPriceChangePct && Math.abs(delta) < cfg.minPriceChangeCents) {
    return events;
  }

  const type: EventType = delta < 0 ? "PRICE_DROP" : "PRICE_INCREASE";
  const arrow = delta < 0 ? "→" : "→";

  events.push(
    draft({
      entityType: "PRODUCT",
      entityKey: p.externalId,
      eventType: type,
      oldValue: { priceCents: oldPrice },
      newValue: { priceCents: newPrice },
      headline: `${p.title} ${formatCents(oldPrice, store.currency)} ${arrow} ${formatCents(newPrice, store.currency)} (${pct > 0 ? "+" : ""}${Math.round(pct * 100)}%)`,
      significance: scoreEvent({
        eventType: type,
        store,
        magnitude: priceMagnitude(pct),
        bestsellerRank: p.bestsellerRank,
        priceCents: newPrice,
        crossStoreCount: crossStore.get(p.externalId),
      }),
      backfilled: false,
      occurredAt: now,
      storeId: store.id,
      discriminator: `${p.externalId}:${newPrice}`,
    }),
  );

  return events;
}

function diffAvailability(
  p: NormalizedProduct,
  prev: PreviousProductState,
  store: StoreContext,
  now: Date,
): DraftEvent[] {
  const events: DraftEvent[] = [];

  // Full sell-out is the strongest demand signal obtainable for free.
  if (prev.availableVariants > 0 && p.availableVariants === 0) {
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "PRODUCT_SOLD_OUT",
        oldValue: { availableVariants: prev.availableVariants },
        newValue: { availableVariants: 0 },
        headline: `${p.title} sold out`,
        significance: scoreEvent({
          eventType: "PRODUCT_SOLD_OUT",
          store,
          magnitude: 0.8,
          bestsellerRank: p.bestsellerRank,
          priceCents: p.priceMinCents,
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${dayBucket(now)}`,
      }),
    );
    return events;
  }

  if (prev.availableVariants === 0 && p.availableVariants > 0) {
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "PRODUCT_RESTOCKED",
        oldValue: { availableVariants: 0 },
        newValue: { availableVariants: p.availableVariants },
        headline: `${p.title} restocked`,
        significance: scoreEvent({
          eventType: "PRODUCT_RESTOCKED",
          store,
          magnitude: 0.6,
          bestsellerRank: p.bestsellerRank,
          priceCents: p.priceMinCents,
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${dayBucket(now)}`,
      }),
    );
    return events;
  }

  // Partial sell-through: low-significance on its own, but it is the leading
  // indicator that precedes a full sell-out, so it is worth persisting.
  if (p.availableVariants < prev.availableVariants && p.variantCount > 1) {
    const lost = prev.availableVariants - p.availableVariants;
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "VARIANT_SOLD_OUT",
        oldValue: { availableVariants: prev.availableVariants },
        newValue: { availableVariants: p.availableVariants },
        headline: `${p.title}: ${lost} of ${p.variantCount} variants sold out`,
        significance: scoreEvent({
          eventType: "VARIANT_SOLD_OUT",
          store,
          magnitude: lost / Math.max(1, p.variantCount),
          bestsellerRank: p.bestsellerRank,
          priceCents: p.priceMinCents,
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${p.availableVariants}:${dayBucket(now)}`,
      }),
    );
  }

  return events;
}

function diffRank(
  p: NormalizedProduct,
  prev: PreviousProductState,
  store: StoreContext,
  cfg: DiffConfig,
  now: Date,
): DraftEvent[] {
  const events: DraftEvent[] = [];
  const oldRank = prev.bestsellerRank;
  const newRank = p.bestsellerRank;

  if (newRank === null) {
    if (oldRank !== null && oldRank < cfg.bestsellerWindow) {
      events.push(
        draft({
          entityType: "PRODUCT",
          entityKey: p.externalId,
          eventType: "BESTSELLER_DROPPED",
          oldValue: { rank: oldRank },
          newValue: { rank: null },
          headline: `${p.title} fell out of the top ${cfg.bestsellerWindow}`,
          significance: scoreEvent({
            eventType: "BESTSELLER_DROPPED",
            store,
            magnitude: 0.5,
            bestsellerRank: oldRank,
            priceCents: p.priceMinCents,
          }),
          backfilled: false,
          occurredAt: now,
          storeId: store.id,
          discriminator: `${p.externalId}:${dayBucket(now)}`,
        }),
      );
    }
    return events;
  }

  if (newRank >= cfg.bestsellerWindow) return events;

  if (oldRank === null) {
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "BESTSELLER_ENTERED",
        oldValue: { rank: null },
        newValue: { rank: newRank },
        headline: `${p.title} entered the bestsellers at #${newRank + 1}`,
        significance: scoreEvent({
          eventType: "BESTSELLER_ENTERED",
          store,
          magnitude: 1 - newRank / cfg.bestsellerWindow,
          bestsellerRank: newRank,
          priceCents: p.priceMinCents,
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${dayBucket(now)}`,
      }),
    );
    return events;
  }

  const improvement = oldRank - newRank;
  if (improvement >= cfg.minRankImprovement) {
    events.push(
      draft({
        entityType: "PRODUCT",
        entityKey: p.externalId,
        eventType: "BESTSELLER_CLIMBED",
        oldValue: { rank: oldRank },
        newValue: { rank: newRank },
        headline: `${p.title} climbed #${oldRank + 1} → #${newRank + 1}`,
        significance: scoreEvent({
          eventType: "BESTSELLER_CLIMBED",
          store,
          magnitude: rankMagnitude(improvement),
          bestsellerRank: newRank,
          priceCents: p.priceMinCents,
        }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: `${p.externalId}:${newRank}:${dayBucket(now)}`,
      }),
    );
  }

  return events;
}

// Theme stays here rather than moving into diffEntitySet: it's a scalar
// value change ("which theme"), not set membership ("which apps"), and
// doesn't fit the appears/persists/disappears shape entities share.
function diffTech(
  snapshot: NormalizedStoreSnapshot,
  store: StoreContext,
  now: Date,
): DraftEvent[] {
  const events: DraftEvent[] = [];
  const tech = snapshot.tech;
  if (!tech) return events;

  if (tech.themeName && store.themeName && tech.themeName !== store.themeName) {
    events.push(
      draft({
        entityType: "TECH",
        entityKey: "theme",
        eventType: "THEME_CHANGED",
        oldValue: { name: store.themeName, version: store.themeVersion },
        newValue: { name: tech.themeName, version: tech.themeVersion },
        headline: `Rebuilt storefront: ${store.themeName} → ${tech.themeName}`,
        significance: scoreEvent({ eventType: "THEME_CHANGED", store, magnitude: 0.9 }),
        backfilled: false,
        occurredAt: now,
        storeId: store.id,
        discriminator: tech.themeName,
      }),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function draft(args: {
  entityType: DraftEvent["entityType"];
  entityKey: string;
  eventType: EventType;
  oldValue: unknown;
  newValue: unknown;
  headline: string;
  significance: number;
  backfilled: boolean;
  occurredAt: Date;
  storeId: string;
  discriminator: string;
}): DraftEvent {
  return {
    entityType: args.entityType,
    entityKey: args.entityKey,
    eventType: args.eventType,
    oldValue: args.oldValue,
    newValue: args.newValue,
    headline: args.headline,
    significance: args.significance,
    backfilled: args.backfilled,
    occurredAt: args.occurredAt,
    dedupeKey: makeDedupeKey({
      storeId: args.storeId,
      entityKey: args.entityKey,
      eventType: args.eventType,
      discriminator: args.discriminator,
    }),
  };
}

function toUpsert(
  p: NormalizedProduct,
  prev: PreviousProductState | null,
  now: Date,
  stateChanged: boolean,
): ProductUpsert {
  return {
    externalId: p.externalId,
    productId: prev?.id ?? null,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.productType,
    tags: p.tags,
    sourceCreatedAt: p.sourceCreatedAt,
    status: "ACTIVE",
    missingStreak: 0,
    missingSince: null,
    priceMinCents: p.priceMinCents,
    priceMaxCents: p.priceMaxCents,
    compareAtMaxCents: p.compareAtMaxCents,
    variantCount: p.variantCount,
    availableVariants: p.availableVariants,
    bestsellerRank: p.bestsellerRank,
    imageHash: p.imageHash,
    lastSeenAt: now,
    stateChanged,
  };
}

function techPatch(snapshot: NormalizedStoreSnapshot): DiffResult["storePatch"] {
  if (!snapshot.tech) return {};
  return {
    themeName: snapshot.tech.themeName,
    themeVersion: snapshot.tech.themeVersion,
  };
}
