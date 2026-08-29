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

/**
 * Lower is better — used to pick the best row when an account has more than
 * one subscription carrying the SAME feature_key (e.g. a lapsed trial plus a
 * newer paid plan after an upgrade). Note the FREE two-subscription shape
 * (see CpSubscription in schema.prisma) does NOT hit this path: `subf_`
 * carries `store_spy.analysis.run` and `subt_` carries
 * `store_spy.monitoring.slots`, different keys, so a query for either key
 * matches exactly one row.
 */
const REASON_RANK: Record<EntitlementReason, number> = {
  ok: 0,
  trial_expired: 1,
  subscription_inactive: 2,
  no_entitlement: 3,
};

const cmp = <T>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sort rank for "more generous" — null quota (unlimited / boolean grant) is the most generous. Tie-break only, among rows with the same reason. */
function quotaRank(quota: number | null): number {
  return quota === null ? Number.MAX_SAFE_INTEGER : quota;
}

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
      id: true,
      quota: true,
      subscription: { select: { status: true, periodEnd: true, createdAt: true } },
    },
    // Deterministic input order for the sort below — belt to its suspenders.
    orderBy: [{ subscription: { createdAt: "desc" } }, { id: "asc" }],
  });

  if (rows.length === 0) {
    return { allowed: false, quota: null, reason: "no_entitlement" };
  }

  // Total order, so the result is deterministic even when two subscriptions
  // carry the same feature_key with an identical createdAt: best reason, then
  // the more generous quota, then the newer subscription, then the row id.
  return rows
    .map((r) => ({ result: evaluate(r, now), createdAt: r.subscription.createdAt, id: r.id }))
    .sort(
      (a, b) =>
        cmp(REASON_RANK[a.result.reason], REASON_RANK[b.result.reason]) || // best reason
        cmp(quotaRank(b.result.quota), quotaRank(a.result.quota)) || // then most generous quota
        cmp(b.createdAt.getTime(), a.createdAt.getTime()) || // then newer subscription
        cmp(a.id, b.id), // then row id — a total order, so always deterministic
    )[0].result;
}

/**
 * TRANSITIONAL (B2 step 2·B): a coarse plan name for DISPLAY and the
 * upgrade-prompt hint only — never a gate (gates call resolveEntitlement per
 * feature). Derived from the account's `store_spy.analysis.run` ceiling (the
 * M12 matrix: 10 = FREE, 50 = BASIC, 100 = BUSINESS). No entitlement /
 * inactive subscription reads as FREE. This is what `session.ts` fills
 * `CurrentUser.plan` with now that the JWT no longer carries a plan claim.
 *
 * Removed in commit 3 together with `CurrentUser.plan` itself. Until then this
 * runs on EVERY `getCurrentUser()` call — one extra entitlements query per
 * authenticated request, whether or not the caller reads `plan`. If commit 3
 * slips, that cost is silent. Grep "TRANSITIONAL (B2 step 2·B)".
 */
export async function resolvePlanSlug(
  prisma: Pick<PrismaClient, "cpEntitlement">,
  userId: string,
  now: Date = new Date(),
): Promise<"FREE" | "BASIC" | "BUSINESS"> {
  const ent = await resolveEntitlement(prisma, { accountId: `acct_${userId}`, featureKey: "store_spy.analysis.run" }, now);
  if (!ent.allowed) return "FREE";
  if (ent.quota === 100) return "BUSINESS";
  if (ent.quota === 50) return "BASIC";
  return "FREE";
}
