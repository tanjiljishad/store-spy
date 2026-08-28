/**
 * B2 step 1 — SEMANTIC verification of the control-plane backfill.
 *
 * Structural checks (row counts, FK integrity, types) live in the migration
 * verification. This one is different: for every store_spy."User" it computes
 * what plan-limits.ts grants *today* and compares it, feature by feature, to
 * what the backfilled control_plane rows say via the real resolveEntitlement()
 * — quota, allowed, reason, and the exact trial / paid expiry timestamp.
 *
 * Run it while store_spy."User" is still authoritative (i.e. after the step 1
 * migration, before step 2 touches auth) so any disagreement is free to fix.
 *
 *   npm run verify:b2-step1              # against .env.test's DATABASE_URL
 *   DATABASE_URL=... npx tsx scripts/verify-b2-step1-semantics.ts
 *
 * Exit 0 = every user's two paths agree. Exit 1 = at least one disagreement
 * (printed per user). A paid user whose store_spy."Subscription".expiresAt is
 * already in the past but whose User.plan was never swept back to FREE is a
 * real disagreement and is meant to surface here.
 */
import { PrismaClient } from "@prisma/client";
import { resolveEntitlement } from "../src/lib/control-plane/entitlements";
import { hasCapability, maxActiveMonitoredStores, maxAnalysesPer24h } from "../src/lib/entitlements/entitlement-service";
import type { PlanTier } from "../src/lib/entitlements/plan-limits";

const prisma = new PrismaClient();
const NOW = new Date();

const ANALYSIS_KEY = "store_spy.analysis.run";
const MONITOR_KEY = "store_spy.monitoring.slots";
const ADVANCED_KEY = "store_spy.intelligence.advanced";

type Mismatch = { field: string; today: unknown; controlPlane: unknown };

async function checkUser(u: {
  id: string;
  email: string;
  plan: PlanTier;
  freeTrialEndsAt: Date | null;
}): Promise<Mismatch[]> {
  const accountId = `acct_${u.id}`;
  const m: Mismatch[] = [];

  // --- what plan-limits.ts grants today ---
  const analysisQuotaToday = maxAnalysesPer24h(u.plan); // 10 / 50 / 100 (never null here)
  const monitorQuotaToday = maxActiveMonitoredStores(u.plan); // 1 / 20 / 50
  const advancedToday = hasCapability(u.plan, "ADVANCED_INTELLIGENCE");
  // Analysis is NOT trial-gated today — a FREE user past their trial still
  // analyses (subject to the 24h count). Monitoring IS.
  const analysisAllowedToday = true;
  const monitorAllowedToday =
    u.plan === "FREE" ? u.freeTrialEndsAt === null || u.freeTrialEndsAt.getTime() > NOW.getTime() : true;

  // --- what the backfilled control_plane rows say ---
  const [arun, mslots, iadv] = await Promise.all([
    resolveEntitlement(prisma, { accountId, featureKey: ANALYSIS_KEY }, NOW),
    resolveEntitlement(prisma, { accountId, featureKey: MONITOR_KEY }, NOW),
    resolveEntitlement(prisma, { accountId, featureKey: ADVANCED_KEY }, NOW),
  ]);

  // analysis.run
  if (arun.quota !== analysisQuotaToday) m.push({ field: "analysis.run quota", today: analysisQuotaToday, controlPlane: arun.quota });
  if (arun.allowed !== analysisAllowedToday)
    m.push({ field: "analysis.run allowed", today: analysisAllowedToday, controlPlane: `${arun.allowed} (${arun.reason})` });

  // monitoring.slots
  if (mslots.quota !== monitorQuotaToday) m.push({ field: "monitoring.slots quota", today: monitorQuotaToday, controlPlane: mslots.quota });
  if (mslots.allowed !== monitorAllowedToday)
    m.push({ field: "monitoring.slots allowed", today: monitorAllowedToday, controlPlane: `${mslots.allowed} (${mslots.reason})` });
  if (u.plan === "FREE") {
    const expectedReason = monitorAllowedToday ? "ok" : "trial_expired";
    if (mslots.reason !== expectedReason)
      m.push({ field: "monitoring.slots reason", today: expectedReason, controlPlane: mslots.reason });
  }

  // intelligence.advanced (boolean capability)
  if (iadv.allowed !== advancedToday) m.push({ field: "intelligence.advanced allowed", today: advancedToday, controlPlane: `${iadv.allowed} (${iadv.reason})` });
  const expectedAdvReason = advancedToday ? "ok" : "no_entitlement";
  if (iadv.reason !== expectedAdvReason) m.push({ field: "intelligence.advanced reason", today: expectedAdvReason, controlPlane: iadv.reason });

  // --- exact expiry timestamps ---
  if (u.plan === "FREE") {
    const trialSub = await prisma.cpSubscription.findUnique({ where: { id: `subt_${u.id}` }, select: { periodEnd: true, status: true } });
    const expectedPeriodEnd = u.freeTrialEndsAt; // fallback (created_at + 30d) only applies when this is null; those users are flagged separately below
    if (!trialSub) {
      m.push({ field: "TRIALING subscription", today: "exists", controlPlane: "missing" });
    } else {
      if (trialSub.status !== "TRIALING") m.push({ field: "trial sub status", today: "TRIALING", controlPlane: trialSub.status });
      if (u.freeTrialEndsAt !== null && trialSub.periodEnd?.getTime() !== expectedPeriodEnd?.getTime())
        m.push({ field: "trial period_end", today: u.freeTrialEndsAt?.toISOString(), controlPlane: trialSub.periodEnd?.toISOString() ?? null });
      if (u.freeTrialEndsAt === null && trialSub.periodEnd === null)
        m.push({ field: "trial period_end", today: "null freeTrialEndsAt -> fallback created_at+30d", controlPlane: "null" });
    }
  } else {
    const paidSub = await prisma.cpSubscription.findUnique({ where: { id: `sub_${u.id}` }, select: { periodEnd: true, status: true } });
    const realSub = await prisma.subscription.findFirst({
      where: { userId: u.id, status: "ACTIVE" },
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

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, plan: true, freeTrialEndsAt: true } });
  console.log(`Checking ${users.length} store_spy.User rows against the control_plane backfill (now = ${NOW.toISOString()})\n`);

  let mismatchedUsers = 0;
  for (const u of users) {
    const m = await checkUser(u);
    if (m.length > 0) {
      mismatchedUsers++;
      console.log(`✗ ${u.email}  (${u.id}, plan=${u.plan})`);
      for (const x of m) console.log(`    ${x.field}: today=${JSON.stringify(x.today)}  control_plane=${JSON.stringify(x.controlPlane)}`);
    }
  }

  console.log(`\n${users.length - mismatchedUsers}/${users.length} users agree exactly.`);
  if (mismatchedUsers > 0) {
    console.log(`${mismatchedUsers} user(s) disagree — see above.`);
    process.exitCode = 1;
  } else {
    console.log("No disagreements.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
