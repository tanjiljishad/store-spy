import type { PrismaClient } from "@prisma/client";
import { ANONYMOUS_ANALYSES_PER_24H } from "./plan-limits";

/**
 * Milestone 12 §1.3: the DB-backed ledger behind the anonymous 3-per-24h
 * quota and the global hourly circuit breaker. Deliberately DB-backed, not
 * the in-memory limiter (security/rate-limit.ts) — a 24-hour window cannot
 * live in a process that restarts, and the circuit breaker needs to see
 * every instance's traffic, not just one process's.
 *
 * `ipKey` MUST be getClientIp()'s output (the fixed extractor — Milestone 11
 * fix 1.1). Keying this on the pre-fix, first-entry-trusting version would
 * make the quota free to bypass with a spoofed x-forwarded-for prefix — see
 * anonymous-analysis.integration.test.ts's regression test.
 */

const WINDOW_HOURS = 24;
const CIRCUIT_BREAKER_WINDOW_HOURS = 1;

export type RecordAnonymousAnalysisResult =
  | { outcome: "recorded" }
  | { outcome: "limit_reached"; current: number; max: number; resetsAt: Date | null }
  | { outcome: "circuit_open" };

/**
 * Race-safe the same way recordAnalysisUsage() is: pg_advisory_xact_lock on
 * the ipKey serializes concurrent requests from the same IP so two
 * simultaneous calls with one slot left cannot both succeed.
 */
export async function recordAnonymousAnalysis(
  prisma: PrismaClient,
  ipKey: string,
  domain: string,
  hourlyCeiling: number,
  now: Date = new Date(),
): Promise<RecordAnonymousAnalysisResult> {
  const windowStart = new Date(now.getTime() - WINDOW_HOURS * 60 * 60_000);
  const circuitWindowStart = new Date(now.getTime() - CIRCUIT_BREAKER_WINDOW_HOURS * 60 * 60_000);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('anon-analysis:' || ${ipKey})::bigint)`;

    // Global circuit breaker first — an IP that's individually under its own
    // quota still can't proceed while the whole system is over the ceiling;
    // this is the backstop distributed abuse (many IPs, few requests each)
    // that a per-IP quota alone can't see.
    const globalRecent = await tx.anonymousAnalysis.count({ where: { createdAt: { gte: circuitWindowStart } } });
    if (globalRecent >= hourlyCeiling) {
      return { outcome: "circuit_open" };
    }

    const windowRows = await tx.anonymousAnalysis.findMany({
      where: { ipKey, createdAt: { gte: windowStart } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    if (windowRows.length >= ANONYMOUS_ANALYSES_PER_24H) {
      const oldest = windowRows[0]?.createdAt ?? null;
      const resetsAt = oldest ? new Date(oldest.getTime() + WINDOW_HOURS * 60 * 60_000) : null;
      return { outcome: "limit_reached", current: windowRows.length, max: ANONYMOUS_ANALYSES_PER_24H, resetsAt };
    }

    await tx.anonymousAnalysis.create({ data: { ipKey, domain } });
    return { outcome: "recorded" };
  });
}

export async function countAnonymousAnalysesInWindow(
  prisma: PrismaClient,
  ipKey: string,
  windowHours: number = WINDOW_HOURS,
): Promise<number> {
  return prisma.anonymousAnalysis.count({
    where: { ipKey, createdAt: { gte: new Date(Date.now() - windowHours * 60 * 60_000) } },
  });
}

const SWEEP_MAX_AGE_HOURS = 48;

/** Run from the worker tick, next to the other sweeps. 48h, not 30 days like AnalysisUsage: no admin-analytics retention need has been asked for here, and this table has no per-user identity to aggregate by anyway. */
export async function sweepOldAnonymousAnalyses(prisma: PrismaClient, now: Date = new Date()): Promise<{ deletedCount: number }> {
  const cutoff = new Date(now.getTime() - SWEEP_MAX_AGE_HOURS * 60 * 60_000);
  const result = await prisma.anonymousAnalysis.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { deletedCount: result.count };
}
