import type { PrismaClient } from "@prisma/client";
import { maxActiveMonitoredStores, maxUniqueAnalyses } from "../entitlements/entitlement-service";
import type { Limit, PlanTier } from "../entitlements/plan-limits";
import { daysRemaining } from "../days-remaining";

/**
 * Aggregates exactly what the dashboard needs — derived, presentation-ready
 * data (domains, counts, ISO dates), never raw Prisma rows. `active` is a
 * LIST, not a single watch: FREE caps it at 1 in practice, but the shape
 * doesn't assume that — PAID can have up to 10, and this same function
 * serves both without a plan-specific branch.
 */

export interface DashboardAnalyzedStore {
  domain: string;
  productCount: number;
  analyzedAt: string;
}

export interface DashboardActiveWatch {
  domain: string;
  startedAt: string;
  /** null for non-expiring monitoring. */
  expiresAt: string | null;
  /** null alongside expiresAt === null. */
  daysRemaining: number | null;
  tier: "HOT" | "WARM" | "COOL" | "COLD" | "DORMANT" | "DISABLED";
  lastCrawledAt: string | null;
  nextCrawlAt: string | null;
}

export interface DashboardSummary {
  email: string;
  plan: PlanTier;
  analyses: { used: number; limit: Limit; stores: DashboardAnalyzedStore[] };
  monitoring: { active: DashboardActiveWatch[]; slotsUsed: number; slotsLimit: Limit };
}

export async function getDashboardSummary(prisma: PrismaClient, userId: string, now: Date = new Date()): Promise<DashboardSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, plan: true } });

  const usageRows = await prisma.analysisUsage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { store: { select: { id: true, domain: true } } },
  });
  const storeIds = usageRows.map((u) => u.storeId);
  const productCounts =
    storeIds.length > 0
      ? await prisma.product.groupBy({ by: ["storeId"], where: { storeId: { in: storeIds }, status: "ACTIVE" }, _count: { _all: true } })
      : [];
  const countByStore = new Map(productCounts.map((p) => [p.storeId, p._count._all]));

  const activeWatches = await prisma.watchlist.findMany({
    where: { userId, monitoringStatus: "ACTIVE" },
    orderBy: { monitoringStartedAt: "desc" },
    include: { store: { select: { domain: true, tier: true, lastCrawledAt: true, nextCrawlAt: true } } },
  });

  return {
    email: user.email,
    plan: user.plan,
    analyses: {
      used: usageRows.length,
      limit: maxUniqueAnalyses(user.plan),
      stores: usageRows.map((u) => ({
        domain: u.store.domain,
        productCount: countByStore.get(u.storeId) ?? 0,
        analyzedAt: u.createdAt.toISOString(),
      })),
    },
    monitoring: {
      active: activeWatches
        .filter((w) => w.monitoringStartedAt)
        .map((w) => ({
          domain: w.store.domain,
          startedAt: w.monitoringStartedAt!.toISOString(),
          expiresAt: w.monitoringExpiresAt?.toISOString() ?? null,
          daysRemaining: w.monitoringExpiresAt ? daysRemaining(w.monitoringExpiresAt, now) : null,
          tier: w.store.tier,
          lastCrawledAt: w.store.lastCrawledAt?.toISOString() ?? null,
          nextCrawlAt: w.store.tier === "DISABLED" ? null : w.store.nextCrawlAt.toISOString(),
        })),
      slotsUsed: activeWatches.length,
      slotsLimit: maxActiveMonitoredStores(user.plan),
    },
  };
}
