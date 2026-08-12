import type { PrismaClient } from "@prisma/client";

/**
 * Historical advertising signals, derived live from real Event and
 * AdObservation/MarketingCollectionRun rows — same discipline as
 * monitoring/activity.ts's getActivitySummary(), deliberately mirrored
 * rather than reinvented: a store checked only once must never receive a
 * fabricated "newly detected" or "no longer detected" delta, because with
 * only one data point there is nothing to compare against. See
 * hasEnoughHistory below.
 */

export interface MarketingActivitySummary {
  windowDays: number;
  adsDetected: number;
  adsRemoved: number;
  /** Ads currently ACTIVE_EVIDENCE, right now — not window-scoped. */
  currentActiveAdCount: number;
  /** Of those currently active, how many were already active before this window started (i.e. not new this window). */
  continuouslyObservedAdCount: number;
  collectionsInWindow: number;
  /**
   * False until a SECOND successful marketing collection has ever completed
   * for this store. Before that, "newly detected" is meaningless (there was
   * no prior state to detect a change from) and must not be shown as if it
   * were a real zero.
   */
  hasEnoughHistory: boolean;
}

export async function getMarketingActivitySummary(
  prisma: PrismaClient,
  storeId: string,
  windowDays = 30,
): Promise<MarketingActivitySummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [adsDetected, adsRemoved, currentActiveAdCount, continuouslyObservedAdCount, collectionsInWindow, totalSuccessfulCollections] =
    await Promise.all([
      prisma.event.count({ where: { storeId, eventType: "AD_DETECTED", occurredAt: { gte: since } } }),
      prisma.event.count({ where: { storeId, eventType: "AD_REMOVED", occurredAt: { gte: since } } }),
      prisma.adObservation.count({ where: { storeId, platform: "GOOGLE", status: "ACTIVE_EVIDENCE" } }),
      prisma.adObservation.count({
        where: { storeId, platform: "GOOGLE", status: "ACTIVE_EVIDENCE", firstSeenAt: { lt: since } },
      }),
      prisma.marketingCollectionRun.count({
        where: { storeId, platform: "GOOGLE", outcome: "SUCCESS", startedAt: { gte: since } },
      }),
      prisma.marketingCollectionRun.count({ where: { storeId, platform: "GOOGLE", outcome: "SUCCESS" } }),
    ]);

  return {
    windowDays,
    adsDetected,
    adsRemoved,
    currentActiveAdCount,
    continuouslyObservedAdCount,
    collectionsInWindow,
    hasEnoughHistory: totalSuccessfulCollections >= 2,
  };
}
