import type { PrismaClient } from "@prisma/client";
import { getProductPersistence, MIN_CRAWLS_FOR_PERSISTENCE, type PersistenceProductInput, type PersistenceResult } from "./persistence";

/**
 * Foundation for a product freshness/persistence signal — deliberately
 * labels, not a score (see docs/milestone-5-growth-signals-research.md
 * Section 12). The underlying persistence computation always rides along
 * with the label; the label alone is a summary, never the whole story.
 */
export type FreshnessLabel = "NEW" | "ESTABLISHED" | "RECENTLY_MISSING" | "INSUFFICIENT_HISTORY";

export interface FreshnessSignal {
  label: FreshnessLabel;
  firstSeenAt: Date;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  missingSince: Date | null;
  persistence: PersistenceResult;
}

/**
 * PURE.
 *   RECENTLY_MISSING — currently MISSING or REMOVED. Leads over any
 *     persistence nuance: the dominant fact right now is absence.
 *   ESTABLISHED — ACTIVE, and enough real crawl history exists since
 *     firstSeenAt to compute a persistence ratio at all.
 *   NEW — ACTIVE, not enough history for THIS product yet, but the store
 *     itself has plenty of history — the shortfall is because the product
 *     was only just discovered, which is itself the signal.
 *   INSUFFICIENT_HISTORY — ACTIVE, but the store as a whole hasn't been
 *     crawled enough times yet to classify anything reliably.
 */
export function classifyFreshness(status: "ACTIVE" | "MISSING" | "REMOVED", persistence: PersistenceResult): FreshnessLabel {
  if (status !== "ACTIVE") return "RECENTLY_MISSING";
  if (persistence.status === "OBSERVED") return "ESTABLISHED";
  return persistence.storeRealCrawlCount >= MIN_CRAWLS_FOR_PERSISTENCE ? "NEW" : "INSUFFICIENT_HISTORY";
}

export type FreshnessProductInput = PersistenceProductInput;

export async function getFreshnessSignal(
  prisma: PrismaClient,
  storeId: string,
  product: FreshnessProductInput,
): Promise<FreshnessSignal> {
  const persistence = await getProductPersistence(prisma, storeId, product);
  return {
    label: classifyFreshness(product.status, persistence),
    firstSeenAt: product.firstSeenAt,
    status: product.status,
    missingSince: product.missingSince,
    persistence,
  };
}
