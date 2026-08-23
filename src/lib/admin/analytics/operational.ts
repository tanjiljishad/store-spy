import type { PrismaClient } from "@prisma/client";
import { utcParam } from "./window";

/**
 * Milestone 12 §3.1: "scheduler lag (stores past nextCrawlAt), failure
 * streaks, stores at DISABLED, promo redemption counts."
 *
 * Scheduler lag / failure streaks / DISABLED count are point-in-time
 * ("as of now"), not windowed — a store is either currently overdue or
 * isn't. Promo redemptions are the one genuinely windowed figure here.
 *
 * The `nextCrawlAt <= now` comparison mirrors monitoring/scheduler.ts's
 * claimDueStores() exactly, including its own utcParam() cast — "nextCrawlAt"
 * is the same timestamp(3)-no-tz column that function's own doc comment
 * warns about.
 */
export interface OperationalMetrics {
  asOf: Date;
  windowStart: Date;
  windowEnd: Date;
  schedulerLagCount: number;
  disabledStoreCount: number;
  storesOnFailureStreak: number;
  promoRedemptionsInWindow: number;
}

export async function getOperationalMetrics(
  prisma: PrismaClient,
  now: Date,
  windowStart: Date,
  windowEnd: Date,
): Promise<OperationalMetrics> {
  const nowParam = utcParam(now);
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);

  const [lagRows, disabledRows, failureStreakRows, redemptionRows] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "Store"
      WHERE tier != 'DISABLED' AND "nextCrawlAt" <= ${nowParam}
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "Store" WHERE tier = 'DISABLED'
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "Store" WHERE "failureStreak" > 0
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "PromoRedemption"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    `,
  ]);

  return {
    asOf: now,
    windowStart,
    windowEnd,
    schedulerLagCount: lagRows[0].n,
    disabledStoreCount: disabledRows[0].n,
    storesOnFailureStreak: failureStreakRows[0].n,
    promoRedemptionsInWindow: redemptionRows[0].n,
  };
}
