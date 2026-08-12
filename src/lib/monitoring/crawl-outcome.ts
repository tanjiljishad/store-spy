import type { PrismaClient } from "@prisma/client";
import { nextCrawlAfterFailure, shouldDemoteToDisabled } from "./policy";

/**
 * Shared by every place a crawl can fail before ever reaching persist.ts —
 * run-analysis.ts's crawler-level failures (blocked/not_found/error) and the
 * zero-products case both fail before runDiffAndPersist() is called, so
 * runDiffAndPersist()'s own success-path scheduling (see persist.ts) never
 * runs for them. The scheduled-crawl path hits the same failures and must
 * back off identically — one function, not two copies of the backoff math.
 *
 * Read-then-write, not FOR UPDATE SKIP LOCKED: two failures for the same
 * store landing here at literally the same instant is a rare edge case, and
 * losing one increment just means slightly gentler backoff — not the kind of
 * correctness risk the scheduler's claim path has to close.
 */
export async function applyCrawlFailureToStore(
  prisma: PrismaClient,
  storeId: string,
  now: Date,
): Promise<void> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { failureStreak: true, tier: true },
  });

  const failureStreak = store.failureStreak + 1;
  const demote = store.tier !== "DISABLED" && shouldDemoteToDisabled(failureStreak);

  await prisma.store.update({
    where: { id: storeId },
    data: {
      failureStreak,
      nextCrawlAt: nextCrawlAfterFailure(failureStreak, now),
      ...(demote ? { tier: "DISABLED" as const } : {}),
    },
  });
}
