import type { PrismaClient } from "@prisma/client";
import { monitoringDurationDays } from "../entitlements/entitlement-service";
import { isUnderLimit } from "../entitlements/plan-limits";
import type { PlanTier } from "../entitlements/plan-limits";
import { resolveEntitlement } from "../control-plane/entitlements";

/**
 * The per-user monitoring relationship: starting/stopping a Watchlist row's
 * ACTIVE state, and keeping the GLOBAL, shared Store.tier in sync with
 * whether *any* user currently has it under active free/paid monitoring.
 *
 * Store.tier is global by design (see schema.prisma's CrawlTier comment —
 * "HOT: on a paid user's watchlist"); it must reflect the union of every
 * user's watch, not just the most recent caller, so recomputeStoreTier()
 * always re-derives it from a fresh COUNT rather than being told "on" or
 * "off" by the caller. A DISABLED store (dead domain / blocked) is left
 * alone either way — watching a dead store doesn't resurrect it, and that
 * transition belongs exclusively to the existing failure-backoff path in
 * crawl-outcome.ts.
 */

export type StartMonitoringResult =
  | { outcome: "started"; expiresAt: Date | null }
  | { outcome: "already_active"; expiresAt: Date | null }
  | { outcome: "limit_reached"; current: number; max: number }
  | { outcome: "trial_expired" };

export async function startMonitoring(
  prisma: PrismaClient,
  userId: string,
  storeId: string,
  plan: PlanTier,
  now: Date = new Date(),
): Promise<StartMonitoringResult> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('watch:' || ${userId})::bigint)`;

    const existing = await tx.watchlist.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { monitoringStatus: true, monitoringExpiresAt: true },
    });
    if (existing?.monitoringStatus === "ACTIVE") {
      return { outcome: "already_active" as const, expiresAt: existing.monitoringExpiresAt };
    }

    // B2 2·B (commit 1): the monitoring gate — "may this account monitor, and
    // up to how many" — now comes from the `store_spy.monitoring.slots`
    // entitlement. For a FREE account that grant lives on the TRIALING
    // subscription, so resolveEntitlement() returns `trial_expired` once the
    // 30-day window is past (exactly the check that used to read
    // User.freeTrialEndsAt here). Still BEFORE the count check — a user whose
    // only watch already expired is under the count limit but must still be
    // rejected outright, not have a new already-past watch created.
    const ent = await resolveEntitlement(tx, { accountId: `acct_${userId}`, featureKey: "store_spy.monitoring.slots" }, now);
    if (!ent.allowed) {
      if (ent.reason === "trial_expired") return { outcome: "trial_expired" as const };
      // subscription_inactive / no_entitlement — no dedicated UI state; a 0/0
      // limit_reached is the least-misleading shape the response envelope has.
      return { outcome: "limit_reached" as const, current: 0, max: 0 };
    }

    // The per-watch expiry ceiling for a FREE watch is the account's monitoring
    // trial end — the TRIALING subscription's period_end (B2 2·B commit 3a;
    // this was store_spy.User.freeTrialEndsAt, which the step-1 backfill and
    // every write path keep byte-identical to subt_.period_end). Only the GATE
    // above moved to entitlements in commit 1; this is the sweep mechanism.
    let freeTrialEndsAt: Date | null = null;
    if (plan === "FREE") {
      const trialSub = await tx.cpSubscription.findFirst({
        where: { accountId: `acct_${userId}`, status: "TRIALING" },
        select: { periodEnd: true },
      });
      freeTrialEndsAt = trialSub?.periodEnd ?? null;
    }

    const activeCount = await tx.watchlist.count({ where: { userId, monitoringStatus: "ACTIVE" } });
    const limit = ent.quota;
    if (!isUnderLimit(activeCount, limit)) {
      // isUnderLimit(count, null) is always true, so reaching this branch
      // guarantees limit !== null.
      return { outcome: "limit_reached" as const, current: activeCount, max: limit as number };
    }

    // Milestone 12 §1.4, per D1: a FREE watch's expiry is the EARLIER of
    // the plan's own duration-based expiry (today, null/continuous for
    // every plan) and the user's free-trial ceiling — "the cleanest
    // implementation sets each FREE watch's monitoringExpiresAt to
    // min(freeTrialEndsAt, watchExpiry) at creation time and changes
    // nothing in the sweep" (the milestone doc's own words). Paid plans
    // never carry a trial ceiling at all.
    const durationDays = monitoringDurationDays(plan);
    const watchExpiry = durationDays === null ? null : new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    let expiresAt = watchExpiry;
    if (plan === "FREE" && freeTrialEndsAt !== null) {
      expiresAt = watchExpiry === null || freeTrialEndsAt < watchExpiry ? freeTrialEndsAt : watchExpiry;
    }

    await tx.watchlist.upsert({
      where: { userId_storeId: { userId, storeId } },
      create: { userId, storeId, monitoringStartedAt: now, monitoringExpiresAt: expiresAt, monitoringStatus: "ACTIVE" },
      update: { monitoringStartedAt: now, monitoringExpiresAt: expiresAt, monitoringStatus: "ACTIVE" },
    });

    return { outcome: "started" as const, expiresAt };
  });

  if (result.outcome === "started") {
    await recomputeStoreTier(prisma, storeId);
  }
  return result;
}

export async function stopMonitoring(prisma: PrismaClient, userId: string, storeId: string): Promise<void> {
  await prisma.watchlist.updateMany({
    where: { userId, storeId, monitoringStatus: "ACTIVE" },
    data: { monitoringStatus: "REMOVED" },
  });
  await recomputeStoreTier(prisma, storeId);
}

/**
 * Re-derives Store.tier from the current count of ACTIVE watches. Never
 * touches DISABLED. Typed against `Pick<PrismaClient, ...>` rather than the
 * concrete `PrismaClient` so a `tx` from inside someone else's
 * `prisma.$transaction()` is interchangeable with the top-level client —
 * the subscription-expiry downgrade cascade (billing/subscription-sweep.ts)
 * calls this from inside its own transaction for exactly that reason,
 * reusing this function rather than duplicating its logic.
 */
export async function recomputeStoreTier(
  prisma: Pick<PrismaClient, "store" | "watchlist">,
  storeId: string,
): Promise<void> {
  const [store, activeWatchCount] = await Promise.all([
    prisma.store.findUniqueOrThrow({ where: { id: storeId }, select: { tier: true } }),
    prisma.watchlist.count({ where: { storeId, monitoringStatus: "ACTIVE" } }),
  ]);

  if (store.tier === "DISABLED") return;

  const desiredTier = activeWatchCount > 0 ? "HOT" : "COLD";
  if (store.tier !== desiredTier) {
    await prisma.store.update({ where: { id: storeId }, data: { tier: desiredTier } });
  }
}

/**
 * Transitions ACTIVE watches past their expiresAt to EXPIRED, and demotes
 * each affected store's tier if it lost its last active watcher. Meant to
 * run alongside every scheduler tick — cheap (one bulk UPDATE) and needs
 * no separate cron.
 *
 * The AT TIME ZONE 'UTC' cast is not decorative — see the "Database time
 * rule" in AGENTS.md. monitoringExpiresAt is timestamp(3) with no time
 * zone; comparing it against a raw-bound Date parameter without this cast
 * implicitly goes through the Postgres session's TimeZone GUC instead of
 * UTC.
 */
export async function expireDueWatches(prisma: PrismaClient, now: Date = new Date()): Promise<{ expiredCount: number }> {
  const expired = await prisma.$queryRaw<{ storeId: string }[]>`
    UPDATE "Watchlist"
    SET "monitoringStatus" = 'EXPIRED'
    WHERE "monitoringStatus" = 'ACTIVE' AND "monitoringExpiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
    RETURNING "storeId"
  `;

  const affectedStoreIds = [...new Set(expired.map((r) => r.storeId))];
  for (const storeId of affectedStoreIds) {
    await recomputeStoreTier(prisma, storeId);
  }

  return { expiredCount: expired.length };
}
