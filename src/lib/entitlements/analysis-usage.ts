import type { PrismaClient } from "@prisma/client";
import { maxUniqueAnalyses } from "./entitlement-service";
import { isUnderLimit } from "./plan-limits";
import type { Limit, PlanTier } from "./plan-limits";

/**
 * The server-side ledger for "how many unique stores has this user
 * analyzed" (spec section 19-20). recordAnalysisUsage() is the only write
 * path and is race-safe under concurrent requests: two simultaneous calls
 * for the SAME user (even for two different new stores) cannot both
 * succeed past a limit of N, because pg_advisory_xact_lock serializes them
 * on userId for the lifetime of the transaction — the second call simply
 * waits for the first to commit (or roll back) before it even runs its own
 * count, rather than racing a check-then-insert. Different users never
 * block each other; the lock key is scoped to userId.
 */

export type RecordAnalysisUsageResult =
  | { outcome: "recorded" }
  | { outcome: "already_counted" } // re-analyzing a store already in the ledger — free, no credit spent
  | { outcome: "limit_reached"; code: "ANALYSIS_LIMIT_REACHED"; capability: "MAX_UNIQUE_ANALYSES" };

export async function recordAnalysisUsage(
  prisma: PrismaClient,
  userId: string,
  storeId: string,
  plan: PlanTier,
): Promise<RecordAnalysisUsageResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('analysis:' || ${userId})::bigint)`;

    const existing = await tx.analysisUsage.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { id: true },
    });
    if (existing) return { outcome: "already_counted" };

    const count = await tx.analysisUsage.count({ where: { userId } });
    if (!isUnderLimit(count, maxUniqueAnalyses(plan))) {
      return { outcome: "limit_reached", code: "ANALYSIS_LIMIT_REACHED", capability: "MAX_UNIQUE_ANALYSES" };
    }

    await tx.analysisUsage.create({ data: { userId, storeId } });
    return { outcome: "recorded" };
  });
}

export async function hasAnalyzedStore(prisma: PrismaClient, userId: string, storeId: string): Promise<boolean> {
  const existing = await prisma.analysisUsage.findUnique({
    where: { userId_storeId: { userId, storeId } },
    select: { id: true },
  });
  return existing !== null;
}

export async function getAnalysisUsage(
  prisma: PrismaClient,
  userId: string,
): Promise<{ used: number; limit: Limit; storeIds: string[] }> {
  const [rows, user] = await Promise.all([
    prisma.analysisUsage.findMany({ where: { userId }, select: { storeId: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } }),
  ]);
  return { used: rows.length, limit: maxUniqueAnalyses(user.plan), storeIds: rows.map((r) => r.storeId) };
}
