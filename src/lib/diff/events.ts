import { sha256 } from "../money";

export type EventType =
  | "STORE_BASELINED"
  | "PRODUCT_ADDED"
  | "PRODUCT_REMOVED"
  | "PRODUCT_RESTORED"
  | "PRICE_DROP"
  | "PRICE_INCREASE"
  | "SALE_STARTED"
  | "SALE_ENDED"
  | "PRODUCT_SOLD_OUT"
  | "PRODUCT_RESTOCKED"
  | "VARIANT_SOLD_OUT"
  | "BESTSELLER_ENTERED"
  | "BESTSELLER_CLIMBED"
  | "BESTSELLER_DROPPED"
  | "COLLECTION_ADDED"
  | "COLLECTION_REMOVED"
  | "THEME_CHANGED"
  | "APP_ADDED"
  | "APP_REMOVED"
  | "PIXEL_ADDED"
  | "PIXEL_REMOVED"
  | "PAYMENT_PROVIDER_ADDED"
  | "PAYMENT_PROVIDER_REMOVED"
  | "AD_DETECTED"
  | "AD_REMOVED"
  | "AD_CHANGED"
  | "PRODUCT_AD_MATCHED";

export type EntityType = "STORE" | "PRODUCT" | "VARIANT" | "COLLECTION" | "TECH" | "AD";

export interface DraftEvent {
  entityType: EntityType;
  entityKey: string;
  eventType: EventType;
  oldValue: unknown;
  newValue: unknown;
  headline: string;
  significance: number; // filled by significance.ts
  backfilled: boolean;
  occurredAt: Date;
  dedupeKey: string;
}

/**
 * Idempotency key. A crawl can be safely retried: re-running produces the same
 * keys, and the unique index on Event.dedupeKey turns duplicate inserts into
 * no-ops. Crawl id is deliberately NOT part of the key for state-transition
 * events, so a retry of the same logical change collapses to one row.
 */
export function makeDedupeKey(parts: {
  storeId: string;
  entityKey: string;
  eventType: EventType;
  /** Discriminator: usually the new value, or a day bucket for noisy types. */
  discriminator: string;
}): string {
  return sha256(
    [parts.storeId, parts.entityKey, parts.eventType, parts.discriminator].join("|"),
  ).slice(0, 40);
}

export function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------

export interface DiffConfig {
  /** Ignore price moves smaller than BOTH of these. Kills rounding/FX noise. */
  minPriceChangePct: number;
  minPriceChangeCents: number;

  /**
   * Consecutive successful, non-partial crawls a product must be absent for
   * before PRODUCT_REMOVED fires. 2 is the minimum that survives one flaky
   * pagination request; 3 is safer for stores you crawl multiple times a day.
   */
  removalConfirmations: number;

  /**
   * If the fresh crawl has fewer than (1 - maxCatalogShrinkRatio) of the
   * previously known ACTIVE products, abort the whole diff. This is the
   * circuit breaker for silent partial failures the crawler didn't flag.
   */
  maxCatalogShrinkRatio: number;

  /** Below this many previously-known products, shrink detection is unreliable. */
  minProductsForShrinkCheck: number;

  /** Rank must improve by at least this many places to emit BESTSELLER_CLIMBED. */
  minRankImprovement: number;

  /** Only ranks inside this cutoff are considered newsworthy at all. */
  bestsellerWindow: number;

  /**
   * Cap on alertable events emitted per crawl. Beyond this, a store is doing a
   * bulk operation (seasonal rotation, migration) and per-item alerts are noise.
   */
  maxEventsPerCrawl: number;
}

export const DEFAULT_DIFF_CONFIG: DiffConfig = {
  minPriceChangePct: 0.02,
  minPriceChangeCents: 100,
  removalConfirmations: 2,
  maxCatalogShrinkRatio: 0.4,
  minProductsForShrinkCheck: 10,
  minRankImprovement: 3,
  bestsellerWindow: 60,
  maxEventsPerCrawl: 200,
};
