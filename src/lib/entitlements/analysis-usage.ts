import type { PrismaClient } from "@prisma/client";
import { isUnderLimit } from "./plan-limits";
import type { Limit } from "./plan-limits";
import { resolveEntitlement } from "../control-plane/entitlements";

/**
 * B2 step 2·B (commit 1): the rolling-24h analysis quota now comes from the
 * control plane (`store_spy.analysis.run` entitlement) instead of
 * `maxAnalysesPer24h(user.plan)`. The COUNTING and the comparison stay here,
 * under the same advisory lock — the control plane only supplies the ceiling
 * (see docs/store-spy-control-plane-b2.md B3). `allowed: false` (an inactive
 * subscription) collapses to a quota of 0, so both the pre-check and the
 * authoritative gate reject it the same way an over-quota caller is rejected.
 */
async function analysisRunQuota(prisma: Pick<PrismaClient, "cpEntitlement">, userId: string): Promise<Limit> {
  const ent = await resolveEntitlement(prisma, { accountId: `acct_${userId}`, featureKey: "store_spy.analysis.run" });
  return ent.allowed ? ent.quota : 0;
}

/**
 * Milestone 12 §1.2: the server-side ledger for "how many analyses has this
 * user run in the last 24 hours" — replaces the old lifetime "unique stores
 * ever analyzed" model. The table is append-only (one row per analysis RUN,
 * not per unique store); recordAnalysisUsage() is still the only write path
 * and is still race-safe under concurrent requests the same way it always
 * was: pg_advisory_xact_lock on userId serializes two simultaneous calls
 * for the SAME user so the second one's count always sees the first one's
 * write (or rollback), never racing a check-then-insert. Different users
 * never block each other.
 *
 * hasAnalyzedStore() answers a DIFFERENT, PERMANENT question — "has this
 * user ever analyzed this store at all" — which grants lasting `full`
 * report access (see auth/store-access.ts's resolveStoreAccess(), a
 * Milestone 11 fix this milestone must not regress). That is unaffected by
 * the windowing change: it is now an EXISTS-shaped query instead of a
 * unique-row lookup, but the answer for any given (userId, storeId) is
 * identical either way, and it keeps working with duplicate rows.
 */

const WINDOW_HOURS = 24;

export type RecordAnalysisUsageResult =
  | { outcome: "recorded" }
  | { outcome: "already_counted" } // same store re-analyzed inside the current 24h window — free, no credit spent (D2)
  | { outcome: "limit_reached"; current: number; max: number; resetsAt: Date | null };

export async function recordAnalysisUsage(
  prisma: PrismaClient,
  userId: string,
  storeId: string,
): Promise<RecordAnalysisUsageResult> {
  const windowStart = new Date(Date.now() - WINDOW_HOURS * 60 * 60_000);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('analysis:' || ${userId})::bigint)`;

    // D2: a repeat analysis of the SAME store inside the current window is
    // free — checked before the quota count, and before insert, all inside
    // the same lock so it can never race a limit_reached decision.
    const existingInWindow = await tx.analysisUsage.findFirst({
      where: { userId, storeId, createdAt: { gte: windowStart } },
      select: { id: true },
    });
    if (existingInWindow) return { outcome: "already_counted" };

    const windowRows = await tx.analysisUsage.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const max = await analysisRunQuota(tx, userId);
    if (!isUnderLimit(windowRows.length, max)) {
      // The oldest row in the window is the one that determines when a slot
      // frees up next — it falls out of the rolling window exactly WINDOW_HOURS after it was written.
      const oldest = windowRows[0]?.createdAt ?? null;
      const resetsAt = oldest ? new Date(oldest.getTime() + WINDOW_HOURS * 60 * 60_000) : null;
      // isUnderLimit(count, null) is always true, so reaching this branch
      // guarantees max !== null — it's typed Limit only because
      // maxAnalysesPer24h() is shared with the unlimited case.
      return { outcome: "limit_reached", current: windowRows.length, max: max as number, resetsAt };
    }

    await tx.analysisUsage.create({ data: { userId, storeId } });
    return { outcome: "recorded" };
  });
}

/**
 * Permanent, non-windowed "has this user ever analyzed this store" —
 * Milestone 11's resolveStoreAccess() gate. Deliberately NOT scoped to the
 * 24h window: a credit spent last month still earns permanent `full` access
 * to that store's report.
 */
export async function hasAnalyzedStore(prisma: PrismaClient, userId: string, storeId: string): Promise<boolean> {
  const existing = await prisma.analysisUsage.findFirst({
    where: { userId, storeId },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Windowed variant of hasAnalyzedStore() — "has this user analyzed this
 * store inside the CURRENT 24h window", used only as run-analysis.ts's
 * fast-fail pre-check optimization (skip a wasted crawl for a caller who's
 * obviously already over quota). Deliberately distinct from the permanent,
 * all-time hasAnalyzedStore(): under the windowed model a store analyzed
 * outside the window is due a fresh credit on re-analysis (D2), so the
 * all-time version would wrongly treat a stale revisit as "already free."
 * recordAnalysisUsage() remains the actual authoritative gate either way.
 */
export async function hasAnalyzedStoreInWindow(
  prisma: PrismaClient,
  userId: string,
  storeId: string,
  windowHours: number = WINDOW_HOURS,
): Promise<boolean> {
  const existing = await prisma.analysisUsage.findFirst({
    where: { userId, storeId, createdAt: { gte: new Date(Date.now() - windowHours * 60 * 60_000) } },
    select: { id: true },
  });
  return existing !== null;
}

export async function countAnalysesInWindow(
  prisma: PrismaClient,
  userId: string,
  windowHours: number = WINDOW_HOURS,
): Promise<number> {
  return prisma.analysisUsage.count({
    where: { userId, createdAt: { gte: new Date(Date.now() - windowHours * 60 * 60_000) } },
  });
}

export async function getAnalysisUsage(
  prisma: PrismaClient,
  userId: string,
): Promise<{ used: number; limit: Limit; resetsAt: Date | null }> {
  const windowStart = new Date(Date.now() - WINDOW_HOURS * 60 * 60_000);
  const [rows, limit] = await Promise.all([
    prisma.analysisUsage.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    analysisRunQuota(prisma, userId),
  ]);
  const oldest = rows[0]?.createdAt ?? null;
  return {
    used: rows.length,
    limit,
    resetsAt: oldest ? new Date(oldest.getTime() + WINDOW_HOURS * 60 * 60_000) : null,
  };
}

const SWEEP_MAX_AGE_DAYS = 30;

/**
 * Milestone 12 §1.2: rows older than 30 days are no longer needed for the
 * 24h quota — kept that long specifically for Phase 3's admin analytics
 * (usage-over-time), not swept immediately once outside the window like
 * AnonymousAnalysis is. Run from the worker tick, next to the other sweeps.
 */
export async function sweepOldAnalysisUsage(prisma: PrismaClient, now: Date = new Date()): Promise<{ deletedCount: number }> {
  const cutoff = new Date(now.getTime() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60_000);
  const result = await prisma.analysisUsage.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { deletedCount: result.count };
}
