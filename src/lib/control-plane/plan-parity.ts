import type { PrismaClient } from "@prisma/client";
import { resolveEntitlement } from "./entitlements";
import { hasCapability, maxActiveMonitoredStores, maxAnalysesPer24h } from "../entitlements/entitlement-service";
import type { PlanTier } from "../entitlements/plan-limits";

/**
 * The B2 semantic-parity check, as a reusable function.
 *
 * For one user, compare what `plan-limits.ts` grants *today* (the still-live
 * `User.plan` path) against what the control-plane entitlement rows say via
 * the real `resolveEntitlement()` — quota, `allowed`, `reason`, and the exact
 * trial / paid expiry timestamp. An empty result means the two agree exactly.
 *
 * Used by `scripts/verify-b2-step1-semantics.ts` (the operator-run gate that
 * must be green before B2 step 2·B lands — every B2 step 2·A dual-write path
 * that writes one side but not the other would diverge silently until then)
 * and by the dual-write parity integration test.
 */

export type PlanParityMismatch = { field: string; today: unknown; controlPlane: unknown };

const ANALYSIS_KEY = "store_spy.analysis.run";
const MONITOR_KEY = "store_spy.monitoring.slots";
const ADVANCED_KEY = "store_spy.intelligence.advanced";

export async function planParityMismatches(
  prisma: Pick<PrismaClient, "cpEntitlement" | "cpSubscription" | "subscription">,
  user: { id: string; plan: PlanTier; freeTrialEndsAt: Date | null },
  now: Date = new Date(),
): Promise<PlanParityMismatch[]> {
  const accountId = `acct_${user.id}`;
  const m: PlanParityMismatch[] = [];

  const analysisQuotaToday = maxAnalysesPer24h(user.plan); // 10 / 50 / 100
  const monitorQuotaToday = maxActiveMonitoredStores(user.plan); // 1 / 20 / 50
  const advancedToday = hasCapability(user.plan, "ADVANCED_INTELLIGENCE");
  // Analysis is NOT trial-gated today (a FREE user past their trial still
  // analyses, subject to the 24h count). Monitoring IS.
  const analysisAllowedToday = true;
  const monitorAllowedToday =
    user.plan === "FREE" ? user.freeTrialEndsAt === null || user.freeTrialEndsAt.getTime() > now.getTime() : true;

  const [arun, mslots, iadv] = await Promise.all([
    resolveEntitlement(prisma, { accountId, featureKey: ANALYSIS_KEY }, now),
    resolveEntitlement(prisma, { accountId, featureKey: MONITOR_KEY }, now),
    resolveEntitlement(prisma, { accountId, featureKey: ADVANCED_KEY }, now),
  ]);

  if (arun.quota !== analysisQuotaToday) m.push({ field: "analysis.run quota", today: analysisQuotaToday, controlPlane: arun.quota });
  if (arun.allowed !== analysisAllowedToday)
    m.push({ field: "analysis.run allowed", today: analysisAllowedToday, controlPlane: `${arun.allowed} (${arun.reason})` });

  if (mslots.quota !== monitorQuotaToday) m.push({ field: "monitoring.slots quota", today: monitorQuotaToday, controlPlane: mslots.quota });
  if (mslots.allowed !== monitorAllowedToday)
    m.push({ field: "monitoring.slots allowed", today: monitorAllowedToday, controlPlane: `${mslots.allowed} (${mslots.reason})` });
  if (user.plan === "FREE") {
    const expectedReason = monitorAllowedToday ? "ok" : "trial_expired";
    if (mslots.reason !== expectedReason) m.push({ field: "monitoring.slots reason", today: expectedReason, controlPlane: mslots.reason });
  }

  if (iadv.allowed !== advancedToday)
    m.push({ field: "intelligence.advanced allowed", today: advancedToday, controlPlane: `${iadv.allowed} (${iadv.reason})` });
  const expectedAdvReason = advancedToday ? "ok" : "no_entitlement";
  if (iadv.reason !== expectedAdvReason) m.push({ field: "intelligence.advanced reason", today: expectedAdvReason, controlPlane: iadv.reason });

  if (user.plan === "FREE") {
    const trialSub = await prisma.cpSubscription.findUnique({ where: { id: `subt_${user.id}` }, select: { periodEnd: true, status: true } });
    if (!trialSub) {
      m.push({ field: "TRIALING subscription", today: "exists", controlPlane: "missing" });
    } else {
      if (trialSub.status !== "TRIALING") m.push({ field: "trial sub status", today: "TRIALING", controlPlane: trialSub.status });
      if (user.freeTrialEndsAt !== null && trialSub.periodEnd?.getTime() !== user.freeTrialEndsAt.getTime())
        m.push({ field: "trial period_end", today: user.freeTrialEndsAt.toISOString(), controlPlane: trialSub.periodEnd?.toISOString() ?? null });
    }
  } else {
    const paidSub = await prisma.cpSubscription.findUnique({ where: { id: `sub_${user.id}` }, select: { periodEnd: true } });
    const realSub = await prisma.subscription.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
      orderBy: { startedAt: "desc" },
      select: { expiresAt: true },
    });
    const expectedPeriodEnd = realSub?.expiresAt ?? null;
    if (!paidSub) {
      m.push({ field: "paid subscription", today: "exists", controlPlane: "missing" });
    } else if (paidSub.periodEnd?.getTime() !== expectedPeriodEnd?.getTime()) {
      m.push({
        field: "paid period_end",
        today: `store_spy.Subscription.expiresAt = ${expectedPeriodEnd?.toISOString() ?? "null"}`,
        controlPlane: paidSub.periodEnd?.toISOString() ?? null,
      });
    }
  }

  return m;
}
