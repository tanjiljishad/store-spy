/**
 * DEV/TEST-ONLY utility — not a product feature, not reachable from any
 * route or UI. Billing doesn't exist yet (Milestone 3 explicitly excludes
 * it); this is how a user's plan gets changed to BASIC for local testing
 * and live smoke tests until a real subscription system replaces it.
 *
 * Usage: npx tsx scripts/set-user-plan.ts user@example.com BASIC
 */
import { prisma } from "../src/lib/db/prisma";

const VALID_PLANS = ["FREE", "BASIC", "BUSINESS"] as const;

async function main() {
  const [email, plan] = process.argv.slice(2);
  if (!email || !plan) {
    console.error("Usage: npx tsx scripts/set-user-plan.ts <email> <FREE|BASIC|BUSINESS>");
    process.exit(1);
  }
  if (!VALID_PLANS.includes(plan as (typeof VALID_PLANS)[number])) {
    console.error(`Invalid plan "${plan}". Must be one of: ${VALID_PLANS.join(", ")}`);
    process.exit(1);
  }

  const user = await prisma.user.update({
    where: { email },
    data: { plan: plan as (typeof VALID_PLANS)[number] },
    select: { id: true, email: true, plan: true },
  });
  console.log(JSON.stringify(user, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
