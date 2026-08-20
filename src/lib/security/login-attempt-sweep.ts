import type { PrismaClient } from "@prisma/client";
import { LOGIN_ATTEMPT_WINDOW_MS } from "./login-policy";

/**
 * Deletes `LoginAttempt` rows old enough that they can no longer affect any
 * throttle decision — login-policy.ts only ever counts rows inside
 * LOGIN_ATTEMPT_WINDOW_MS (15 minutes), so anything older is pure dead
 * weight on an otherwise unbounded, append-mostly table. 24h (well above
 * the 15-minute window) is deliberate headroom, not a tuned value: this
 * table is small and cheap to over-retain briefly, and the wide margin
 * means a delayed worker cycle can never delete a row a concurrent
 * throttle check might still need. Same shape/placement as
 * monitoring/stale-crawl-sweep.ts — called from the worker tick, next to
 * sweepStaleCrawls.
 */
export const LOGIN_ATTEMPT_RETENTION_MS = 24 * 60 * 60_000;

export interface LoginAttemptSweepResult {
  deleted: number;
}

export async function sweepOldLoginAttempts(
  prisma: PrismaClient,
  now: Date = new Date(),
  retentionMs: number = LOGIN_ATTEMPT_RETENTION_MS,
): Promise<LoginAttemptSweepResult> {
  // Sanity: retention must never be shorter than the window the policy
  // actually reads, or a live throttle decision could lose rows mid-check.
  const effectiveRetentionMs = Math.max(retentionMs, LOGIN_ATTEMPT_WINDOW_MS);
  const cutoff = new Date(now.getTime() - effectiveRetentionMs);

  const result = await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { deleted: result.count };
}
