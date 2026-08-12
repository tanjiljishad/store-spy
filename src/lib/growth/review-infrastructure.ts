import type { PrismaClient } from "@prisma/client";
import { observed, unavailable, type ObservedField, type UnavailableField } from "../analysis/report-contract";

/**
 * Review infrastructure presence — reuses fingerprint.ts's already-shipped
 * app detection (StoreEntity kind=APP), filtered to the review-app subset.
 * No new crawl, no new detection logic: this module is presentation only.
 *
 * Hard rule (see docs/milestone-5-growth-signals-research.md Section 8.3):
 * this signal means "a review collection system is installed." It is never
 * a claim about review volume, authenticity, or customer sentiment — some of
 * these very apps are also used to import a SUPPLIER's reviews onto a
 * reseller's store (Sub-phase A's research), so presence cannot even
 * reliably imply "this store collects its own customers' reviews."
 */
export const REVIEW_APP_KEYS = ["judgeme", "yotpo", "loox", "stamped", "okendo"] as const;
export type ReviewAppKey = (typeof REVIEW_APP_KEYS)[number];

export interface ReviewInfrastructureEntry {
  key: ReviewAppKey;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const NOT_YET_CRAWLED_REASON = "This store has not completed an initial crawl yet.";

export async function getReviewInfrastructureSignal(
  prisma: PrismaClient,
  storeId: string,
  storeBaselinedAt: Date | null,
): Promise<ObservedField<ReviewInfrastructureEntry[]> | UnavailableField> {
  if (!storeBaselinedAt) {
    return unavailable(NOT_YET_CRAWLED_REASON);
  }

  // Bounded by construction: at most REVIEW_APP_KEYS.length rows can ever
  // match, thanks to the (storeId, kind, key) unique constraint on StoreEntity.
  const rows = await prisma.storeEntity.findMany({
    where: { storeId, kind: "APP", key: { in: [...REVIEW_APP_KEYS] } },
    select: { key: true, status: true, firstSeenAt: true, lastSeenAt: true },
  });

  return observed(
    rows.map((r) => ({
      key: r.key as ReviewAppKey,
      status: r.status,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    })),
  );
}
