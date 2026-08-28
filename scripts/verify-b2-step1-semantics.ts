/**
 * B2 — SEMANTIC parity gate for the control-plane dual-writes.
 *
 * For every store_spy."User" it compares what plan-limits.ts grants *today*
 * against what the control_plane rows say via the real resolveEntitlement()
 * — quota, allowed, reason, and the exact trial / paid expiry timestamp
 * (see src/lib/control-plane/plan-parity.ts).
 *
 * Introduced for the step 1 backfill; it is ALSO the standing gate for B2
 * step 2·A: during 2·A every plan write goes to two places (checkout,
 * subscription-sweep, admin setUserPlan / updateUserRole), and any path that
 * writes one side but not the other diverges silently until the 2·B cutover
 * exposes it. Run this after 2·A is deployed and exercised, and require it
 * green before 2·B lands.
 *
 *   npm run verify:b2-step1              # against .env.test's DATABASE_URL
 *   DATABASE_URL=... npx tsx scripts/verify-b2-step1-semantics.ts
 *
 * Exit 0 = every user's two paths agree. Exit 1 = at least one disagreement
 * (printed per user).
 */
import { PrismaClient } from "@prisma/client";
import { planParityMismatches } from "../src/lib/control-plane/plan-parity";

const prisma = new PrismaClient();
const NOW = new Date();

async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, plan: true, freeTrialEndsAt: true } });
  console.log(`Checking ${users.length} store_spy.User rows against the control plane (now = ${NOW.toISOString()})\n`);

  let mismatched = 0;
  for (const u of users) {
    const m = await planParityMismatches(prisma, u, NOW);
    if (m.length > 0) {
      mismatched++;
      console.log(`✗ ${u.email}  (${u.id}, plan=${u.plan})`);
      for (const x of m) console.log(`    ${x.field}: today=${JSON.stringify(x.today)}  control_plane=${JSON.stringify(x.controlPlane)}`);
    }
  }

  console.log(`\n${users.length - mismatched}/${users.length} users agree exactly.`);
  if (mismatched > 0) {
    console.log(`${mismatched} user(s) disagree — see above.`);
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
