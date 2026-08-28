import type { PrismaClient } from "@prisma/client";

/**
 * The control plane's entitlement resolver — the read side of B3.
 *
 * DIVISION OF RESPONSIBILITY (see docs/store-spy-rebrand-and-control-plane.md
 * B3, revised after the B1 review): the control plane owns *the ceiling and
 * the right to it*; the consuming product owns *the current count*.
 *
 * This returns `quota` (the ceiling — null means a boolean capability or an
 * unlimited allowance), `allowed` (derived ONLY from subscription status and
 * trial expiry), and `reason`. It deliberately does NOT return `used` and has
 * no "quota_exceeded" reason: Store Spy's two real quotas are a rolling-24h
 * window (`store_spy.analysis.run`) and a live COUNT of ACTIVE watches
 * (`store_spy.monitoring.slots`), neither of which is a cumulative integer the
 * control plane can compute. Store Spy keeps the `used`-vs-`quota` comparison
 * under the lock its write path already holds (recordAnalysisUsage()'s
 * advisory lock, startMonitoring()'s transactional COUNT). A `false` from that
 * comparison is Store Spy's own LIMIT_REACHED, not this service's.
 */

export type EntitlementReason = "ok" | "no_entitlement" | "subscription_inactive" | "trial_expired";

export interface EntitlementResult {
  allowed: boolean;
  /** The ceiling. null = boolean capability or unlimited. Present whenever an entitlement row exists, even when allowed is false. */
  quota: number | null;
  reason: EntitlementReason;
}

const ACTIVE_STATUSES = new Set(["TRIALING", "ACTIVE"]);

/** Lower is better — used to pick the best row when an account has more than one subscription carrying the same feature_key (e.g. a lapsed trial plus a new paid plan). */
const REASON_RANK: Record<EntitlementReason, number> = {
  ok: 0,
  trial_expired: 1,
  subscription_inactive: 2,
  no_entitlement: 3,
};

function evaluate(
  row: { quota: number | null; subscription: { status: string; periodEnd: Date | null } },
  now: Date,
): EntitlementResult {
  const { status, periodEnd } = row.subscription;
  const expired = periodEnd !== null && periodEnd.getTime() <= now.getTime();

  if (status === "TRIALING" && expired) {
    return { allowed: false, quota: row.quota, reason: "trial_expired" };
  }
  if (!ACTIVE_STATUSES.has(status)) {
    return { allowed: false, quota: row.quota, reason: "subscription_inactive" };
  }
  if (expired) {
    // ACTIVE past its period_end — a lapsed paid plan the subscription sweep
    // hasn't demoted yet. Honestly inactive; not a trial, so not trial_expired.
    return { allowed: false, quota: row.quota, reason: "subscription_inactive" };
  }
  return { allowed: true, quota: row.quota, reason: "ok" };
}

export async function resolveEntitlement(
  prisma: Pick<PrismaClient, "cpEntitlement">,
  args: { accountId: string; featureKey: string },
  now: Date = new Date(),
): Promise<EntitlementResult> {
  const rows = await prisma.cpEntitlement.findMany({
    where: { featureKey: args.featureKey, subscription: { accountId: args.accountId } },
    select: {
      quota: true,
      subscription: { select: { status: true, periodEnd: true, createdAt: true } },
    },
  });

  if (rows.length === 0) {
    return { allowed: false, quota: null, reason: "no_entitlement" };
  }

  // Best reason wins; tie-break on the newer subscription.
  return rows
    .map((r) => ({ result: evaluate(r, now), createdAt: r.subscription.createdAt }))
    .sort((a, b) => {
      const byReason = REASON_RANK[a.result.reason] - REASON_RANK[b.result.reason];
      return byReason !== 0 ? byReason : b.createdAt.getTime() - a.createdAt.getTime();
    })[0].result;
}
