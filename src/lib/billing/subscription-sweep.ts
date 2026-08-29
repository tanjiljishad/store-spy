import type { PrismaClient } from "@prisma/client";
import { maxActiveMonitoredStores } from "../entitlements/entitlement-service";
import { recomputeStoreTier } from "../monitoring/watch";
import { recordAdminAction } from "../admin/audit";
import { resolveTrialEnd, syncControlPlanePlan } from "../control-plane/provision";

/**
 * Milestone 11 Phase 3 §3.4 amendment (post-Phase-2 review): the original
 * spec created a Subscription with expiresAt and stopped — nothing ever
 * read it, so a promo-granted plan would be permanent regardless of the
 * duration an admin intended. This is that missing read path.
 *
 * Structurally unlike monitoring/watch.ts's expireDueWatches() (a single
 * bulk UPDATE): each due subscription needs its OWN transaction, because
 * the downgrade cascade below requires per-user watch selection (retain
 * the oldest N, expire the rest) that a single global statement can't
 * express. One failing subscription is isolated and logged, never taking
 * down the rest of the sweep — same discipline as
 * monitoring/scheduler.ts's per-store isolation.
 */
/**
 * Milestone 12 §1.4: the inverse of the downgrade cascade below — a FREE
 * user upgrading to a paid plan must have any trial-ceiling expiry
 * (min(freeTrialEndsAt, watchExpiry) at watch-creation time, see
 * monitoring/watch.ts's startMonitoring()) lifted from their existing
 * ACTIVE watches immediately, not left to expire on schedule after they've
 * already paid. Safe to call unconditionally on any plan change to a
 * non-FREE plan: clearing an expiry that was never trial-related (no
 * current plan sets one) is a no-op, and every plan-mutation call site
 * either does this or checkout.ts's own equivalent — see setUserPlan() and
 * processCheckout() for the two places `User.plan` is actually written
 * to a paid value today.
 */
export async function clearTrialCeiling(prisma: Pick<PrismaClient, "watchlist">, userId: string): Promise<void> {
  await prisma.watchlist.updateMany({
    where: { userId, monitoringStatus: "ACTIVE", monitoringExpiresAt: { not: null } },
    data: { monitoringExpiresAt: null },
  });
}

export interface ExpireDueSubscriptionsResult {
  /** Subscriptions actually downgraded this sweep. */
  expiredCount: number;
  /** Watches expired across all downgrades, cumulative. */
  watchesExpiredCount: number;
}

export async function expireDueSubscriptions(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ExpireDueSubscriptionsResult> {
  // A plain typed Prisma query — no raw SQL, so none of AGENTS.md's
  // "AT TIME ZONE 'UTC'" caveats apply (typed Date comparisons already
  // round-trip correctly regardless of the Postgres session's TimeZone).
  const due = await prisma.subscription.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: now } },
    select: { id: true },
  });

  let expiredCount = 0;
  let watchesExpiredCount = 0;

  for (const { id: subscriptionId } of due) {
    try {
      const watchesExpired = await expireOneSubscription(prisma, subscriptionId, now);
      if (watchesExpired !== null) {
        expiredCount++;
        watchesExpiredCount += watchesExpired;
      }
    } catch (e) {
      console.error(`[expireDueSubscriptions] failed for subscription ${subscriptionId}:`, e);
    }
  }

  return { expiredCount, watchesExpiredCount };
}

/** Returns the number of watches expired in the cascade, or null if this subscription was already handled (re-checked inside the transaction) or is no longer due. */
async function expireOneSubscription(prisma: PrismaClient, subscriptionId: string, now: Date): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    // Re-check inside the transaction: the SELECT that found this row ran
    // outside any lock, so by the time we get here it may have already
    // been superseded (a new subscription redeemed, or a prior sweep tick
    // already processed it).
    const current = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true, expiresAt: true, userId: true },
    });
    if (!current || current.status !== "ACTIVE" || current.expiresAt === null || current.expiresAt > now) {
      return null;
    }

    await tx.subscription.update({ where: { id: subscriptionId }, data: { status: "EXPIRED" } });

    // B2 2·B: plan lives in the control plane only. Rebuild the account's FREE
    // subscriptions; the returning FREE user's monitoring-trial window is
    // whatever it always was — resolveTrialEnd() (createdAt + 30d for an
    // account that had no trial subscription, i.e. this one), usually already
    // past.
    await syncControlPlanePlan(tx, {
      userId: current.userId,
      plan: "FREE",
      trialEndsAt: await resolveTrialEnd(tx, current.userId),
      paidPeriodEnd: null,
    });

    // Downgrade cascade: a user dropping to FREE may hold more ACTIVE
    // watches than maxActiveMonitoredStores(FREE) allows. Oldest
    // monitoringStartedAt is retained; the rest are expired — reusing
    // recomputeStoreTier() (monitoring/watch.ts) rather than writing a
    // second expiry path, per the amendment's explicit instruction.
    const activeWatches = await tx.watchlist.findMany({
      where: { userId: current.userId, monitoringStatus: "ACTIVE" },
      orderBy: { monitoringStartedAt: "asc" },
      select: { id: true, storeId: true },
    });
    const freeLimit = maxActiveMonitoredStores("FREE");
    const excess = freeLimit === null ? [] : activeWatches.slice(freeLimit);

    if (excess.length > 0) {
      await tx.watchlist.updateMany({
        where: { id: { in: excess.map((w) => w.id) } },
        data: { monitoringStatus: "EXPIRED" },
      });
      for (const w of excess) {
        await recomputeStoreTier(tx, w.storeId);
      }
    }

    // §4.1 addendum: metadata carries only the user id (already the
    // targetId above) — never the subject's email. The admin UI joins to
    // User for display; see audit.ts's own extended doc comment.
    await recordAdminAction(tx, {
      actorId: "system:expiry",
      actorEmail: "system:expiry",
      action: "subscription.expire",
      targetType: "User",
      targetId: current.userId,
      metadata: { subscriptionId, watchesExpired: excess.length },
    });

    return excess.length;
  });
}
