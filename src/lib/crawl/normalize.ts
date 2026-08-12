import { hashOf, toCents } from "../money";
import type {
  NormalizedProduct,
  NormalizedStoreSnapshot,
  NormalizedVariant,
} from "./types";

// --- shape of Shopify's public /products.json ---------------------------------
// Exported so the crawler (shopify.ts) can type its raw HTTP responses against
// the same contract this file normalizes from — one definition, not two.

export interface ShopifyVariant {
  id: number;
  title: string;
  sku: string | null;
  price: string;
  compare_at_price: string | null;
  available: boolean;
  position: number;
}

export interface ShopifyProduct {
  id: number;
  handle: string;
  title: string;
  vendor: string | null;
  product_type: string | null;
  tags: string[] | string;
  created_at: string | null;
  published_at: string | null;
  updated_at: string | null; // deliberately ignored — churns constantly
  variants: ShopifyVariant[];
  images?: Array<{ src: string }>;
}

// -----------------------------------------------------------------------------

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeTags(tags: string[] | string | null | undefined): string[] {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : tags.split(",");
  return list.map((t) => t.trim().toLowerCase()).filter(Boolean).sort();
}

export function normalizeVariant(v: ShopifyVariant): NormalizedVariant | null {
  const priceCents = toCents(v.price);
  if (priceCents === null) return null; // unparseable price -> drop, don't guess

  return {
    externalId: String(v.id),
    title: v.title ?? "",
    sku: v.sku ?? null,
    priceCents,
    compareAtCents: toCents(v.compare_at_price),
    available: Boolean(v.available),
    position: v.position ?? 0,
  };
}

export function normalizeProduct(
  raw: ShopifyProduct,
  bestsellerRank: number | null,
  imageHash: string | null,
): NormalizedProduct | null {
  const variants = (raw.variants ?? [])
    .map(normalizeVariant)
    .filter((v): v is NormalizedVariant => v !== null)
    .sort((a, b) => a.externalId.localeCompare(b.externalId));

  // A product with zero parseable variants has no price. Skipping it is safer
  // than inventing one — a fabricated price becomes a fake PRICE_DROP later.
  if (variants.length === 0) return null;

  const prices = variants.map((v) => v.priceCents);
  const compareAts = variants
    .map((v) => v.compareAtCents)
    .filter((c): c is number => c !== null && c > 0);

  return {
    externalId: String(raw.id),
    handle: raw.handle,
    title: raw.title ?? "",
    vendor: raw.vendor || null,
    productType: raw.product_type || null,
    tags: normalizeTags(raw.tags),
    sourceCreatedAt: parseDate(raw.created_at),
    publishedAt: parseDate(raw.published_at),
    priceMinCents: Math.min(...prices),
    priceMaxCents: Math.max(...prices),
    compareAtMaxCents: compareAts.length > 0 ? Math.max(...compareAts) : null,
    variantCount: variants.length,
    availableVariants: variants.filter((v) => v.available).length,
    variants,
    bestsellerRank,
    imageHash,
  };
}

export interface NormalizeInput {
  domain: string;
  currency: string | null;
  rawProducts: ShopifyProduct[];
  /** externalId -> rank, from /collections/all?sort_by=best-selling */
  bestsellerRanks?: Map<string, number>;
  /** externalId -> perceptual hash of primary image */
  imageHashes?: Map<string, string>;
  collectionHandles?: string[];
  /** Did /collections.json fetch completely (no failure, no truncation)? Defaults true. */
  hasCollectionData?: boolean;
  tech?: NormalizedStoreSnapshot["tech"];
  /** Did the homepage fetch tech/currency are parsed from succeed? Defaults true. */
  hasTechData?: boolean;
  pagesExpected: number | null;
  pagesFetched: number | null;
  httpErrors: number;
  capturedAt?: Date;
}

export function normalizeSnapshot(input: NormalizeInput): NormalizedStoreSnapshot {
  const ranks = input.bestsellerRanks ?? new Map<string, number>();
  const images = input.imageHashes ?? new Map<string, string>();

  const products = input.rawProducts
    .map((p) =>
      normalizeProduct(p, ranks.get(String(p.id)) ?? null, images.get(String(p.id)) ?? null),
    )
    .filter((p): p is NormalizedProduct => p !== null)
    // Stable ordering is required for deterministic hashing.
    .sort((a, b) => a.externalId.localeCompare(b.externalId));

  const partial =
    input.httpErrors > 0 ||
    (input.pagesExpected !== null &&
      input.pagesFetched !== null &&
      input.pagesFetched < input.pagesExpected);

  return {
    domain: input.domain,
    currency: input.currency,
    products,
    collectionHandles: [...(input.collectionHandles ?? [])].sort(),
    hasCollectionData: input.hasCollectionData ?? true,
    tech: input.tech ?? null,
    hasTechData: input.hasTechData ?? true,
    partial,
    pagesExpected: input.pagesExpected,
    pagesFetched: input.pagesFetched,
    httpErrors: input.httpErrors,
    hasRankData: ranks.size > 0,
    capturedAt: input.capturedAt ?? new Date(),
  };
}

// --- hashing -----------------------------------------------------------------
//
// Two hashes, deliberately. Bestseller order changes almost every day; folding
// it into catalogHash would defeat the short-circuit and force a full diff on
// every crawl for every store. Keeping them separate means ~95% of crawls do
// zero product-diff work.

export function computeCatalogHash(snapshot: NormalizedStoreSnapshot): string {
  return hashOf(
    snapshot.products.map((p) => [
      p.externalId,
      p.handle,
      p.title,
      p.priceMinCents,
      p.priceMaxCents,
      p.compareAtMaxCents,
      p.variantCount,
      p.availableVariants,
    ]),
  );
}

export function computeRankHash(snapshot: NormalizedStoreSnapshot): string {
  return hashOf(
    snapshot.products
      .filter((p) => p.bestsellerRank !== null)
      .sort((a, b) => (a.bestsellerRank ?? 0) - (b.bestsellerRank ?? 0))
      .map((p) => p.externalId),
  );
}

export function computeTechHash(snapshot: NormalizedStoreSnapshot): string | null {
  if (!snapshot.tech) return null;
  return hashOf(snapshot.tech);
}
