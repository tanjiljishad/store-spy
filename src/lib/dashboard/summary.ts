import type { PrismaClient } from "@prisma/client";
import { getAnalysisUsage } from "../entitlements/analysis-usage";
import type { Limit, PlanTier } from "../entitlements/plan-limits";
import { resolveEntitlement } from "../control-plane/entitlements";
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
  analyses: {
    /** Milestone 12 §1.2: rolling-24h count, not a lifetime total — see analysis-usage.ts's countAnalysesInWindow(). */
    used: number;
    limit: Limit;
    resetsAt: string | null;
    /** Every store this user has EVER analyzed (permanent access, hasAnalyzedStore()'s own scope) — deduplicated, most-recent analysis first, independent of the windowed used/limit above. */
    stores: DashboardAnalyzedStore[];
  };
  monitoring: { active: DashboardActiveWatch[]; slotsUsed: number; slotsLimit: Limit };
}

export async function getDashboardSummary(prisma: PrismaClient, userId: string, now: Date = new Date()): Promise<DashboardSummary> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, plan: true } });

  const [usage, usageRows, monitorEnt] = await Promise.all([
    getAnalysisUsage(prisma, userId),
    // The AnalysisUsage table is append-only now (Milestone 12 §1.2) — a
    // store re-analyzed on different days has multiple rows. Ordered
    // newest-first and deduplicated by storeId below so the store LIST
    // (permanent access, not the windowed quota) shows each store once, at
    // its most recent analysis time.
    prisma.analysisUsage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { store: { select: { id: true, domain: true } } },
    }),
    // B2 2·B (commit 1): monitored-store limit from the control plane.
    resolveEntitlement(prisma, { accountId: `acct_${userId}`, featureKey: "store_spy.monitoring.slots" }, now),
  ]);

  const seenStoreIds = new Set<string>();
  const dedupedRows = usageRows.filter((u) => {
    if (seenStoreIds.has(u.storeId)) return false;
    seenStoreIds.add(u.storeId);
    return true;
  });

  const storeIds = dedupedRows.map((u) => u.storeId);
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
      used: usage.used,
      limit: usage.limit,
      resetsAt: usage.resetsAt?.toISOString() ?? null,
      stores: dedupedRows.map((u) => ({
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
      slotsLimit: monitorEnt.quota,
    },
  };
}
