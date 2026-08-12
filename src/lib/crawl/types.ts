/**
 * The contract between the crawler and the diff engine.
 *
 * The engine never sees raw Shopify JSON. It only ever sees a
 * NormalizedStoreSnapshot. That boundary is what lets you add
 * WooCommerce or BigCommerce later without touching diff logic.
 */

export interface NormalizedVariant {
  externalId: string;
  title: string;
  sku: string | null;
  priceCents: number;
  compareAtCents: number | null;
  available: boolean;
  position: number;
}

export interface NormalizedProduct {
  externalId: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];

  /** Platform's own creation timestamp — enables retroactive launch timelines. */
  sourceCreatedAt: Date | null;
  publishedAt: Date | null;

  priceMinCents: number;
  priceMaxCents: number;
  compareAtMaxCents: number | null;

  variantCount: number;
  availableVariants: number;
  variants: NormalizedVariant[];

  /** 0-indexed position in /collections/all?sort_by=best-selling, if crawled. */
  bestsellerRank: number | null;

  /** Perceptual hash of the primary image, for cross-store product matching. */
  imageHash: string | null;
}

export interface NormalizedTech {
  themeName: string | null;
  themeVersion: string | null;
  apps: string[];
  pixels: Record<string, string>; // e.g. { facebook: "1234", ga4: "G-XYZ" }
  paymentProviders: string[];
  emailPlatform: string | null;
}

export interface NormalizedStoreSnapshot {
  domain: string;
  currency: string | null;
  products: NormalizedProduct[];
  collectionHandles: string[];
  tech: NormalizedTech | null;

  // --- crawl integrity signals ---
  /**
   * True when at least one page/request failed. Additions and price changes
   * are still trusted; REMOVAL DETECTION IS SUPPRESSED. This single flag
   * prevents the most common and most damaging false positive in the system.
   */
  partial: boolean;
  pagesExpected: number | null;
  pagesFetched: number | null;
  httpErrors: number;

  /** True when bestseller ordering was successfully fetched this crawl. */
  hasRankData: boolean;

  /**
   * True when /collections.json was fetched completely this crawl (every
   * page, no truncation). A genuinely empty result and a failed/truncated
   * fetch both look like collectionHandles.length === 0 or a short array —
   * this is the only thing that tells them apart, same role as hasRankData.
   */
  hasCollectionData: boolean;
  /** True when the homepage fetch that tech/currency are parsed from succeeded. */
  hasTechData: boolean;

  capturedAt: Date;
}

/** Current DB state for one product, loaded in a single query before diffing. */
export interface PreviousProductState {
  id: string;
  externalId: string;
  handle: string;
  title: string;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  priceMinCents: number;
  priceMaxCents: number;
  compareAtMaxCents: number | null;
  variantCount: number;
  availableVariants: number;
  bestsellerRank: number | null;
  missingStreak: number;
  missingSince: Date | null;
  firstSeenAt: Date;
}

/**
 * A named thing that appears, persists, and disappears from a store: an
 * installed app, a tracking pixel, a collection, a payment provider. Same
 * shape as Product for the same reason — it goes through the same
 * ACTIVE -> MISSING -> REMOVED state machine, via diffEntitySet().
 */
export type EntityKind = "APP" | "PIXEL" | "COLLECTION" | "PAYMENT_PROVIDER" | "EMAIL_PLATFORM";

/** Current DB state for one entity, loaded in a single query before diffing. */
export interface PreviousEntityState {
  id: string;
  kind: EntityKind;
  key: string;
  meta: Record<string, unknown> | null;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  missingStreak: number;
  missingSince: Date | null;
  firstSeenAt: Date;
}

export interface StoreContext {
  id: string;
  domain: string;
  currency: string;
  /** Null until the first successful crawl completes. Gates alertable events. */
  baselinedAt: Date | null;
  themeName: string | null;
  themeVersion: string | null;
  entities: PreviousEntityState[];
  stats: {
    priceChangesInWindow: number;
    productsAddedInWindow: number;
    crawlsInWindow: number;
    productCount: number;
    medianPriceCents: number | null;
  } | null;
}
