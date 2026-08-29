/**
 * One-shot verification for migration 20260829000000 (B2 step 3 prep).
 *
 * The migration backfills control_plane.subscriptions.plan_slug from the
 * still-authoritative store_spy."User".plan. This checks that the backfilled
 * column agrees, for EVERY user, with resolvePlanSlug()'s CURRENT output —
 * the quota/status inference that is live in merged code right now and that
 * commit 3 deletes. Two ways they can disagree, both reported distinctly:
 *
 *   BAD BACKFILL       plan_slug != store_spy."User".plan
 *                      -> the UPDATE is wrong; fix the migration.
 *   INFERENCE DISAGREES plan_slug == User.plan, but resolvePlanSlug() differs
 *                      -> an account whose control-plane subscription state
 *                         (usually a lapsed paid period_end not yet swept)
 *                         maps to no tier under the quota/status inference.
 *                         Expected for such users; listed so the decision to
 *                         delete the inference is made with eyes open.
 *   BACKFILL GAP       plan_slug IS NULL, or >1 distinct value per account.
 *
 * Self-seeds a representative population through the real provisioning /
 * sync-plan paths, re-runs the migration's idempotent backfill UPDATE (the
 * seeded rows are created by code that does not set plan_slug yet — commit 3
 * does), then checks. Run against the test DB:
 *
 *   dotenv -e .env.test -- tsx scripts/verify-plan-slug-backfill.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { resolvePlanSlug } from "../src/lib/control-plane/entitlements";
import { syncControlPlanePlan } from "../src/lib/control-plane/provision";
import { makeStoreSpyUser, resetControlPlane } from "../src/lib/test-support/store-spy-user";

const prisma = new PrismaClient();
const DAY = 24 * 60 * 60 * 1000;

const BACKFILL_SQL = `
UPDATE "control_plane"."subscriptions" s
SET "plan_slug" = u."plan"::text
FROM "store_spy"."User" u
WHERE s."account_id" = 'acct_' || u."id"
  AND s."plan_slug" IS NULL
`;

async function seed() {
  const now = new Date();

  // u1: FREE, trial active
  await makeStoreSpyUser(prisma, { email: `ps-free-active-${randomUUID().slice(0, 6)}@t.local`, plan: "FREE", freeTrialEndsAt: new Date(now.getTime() + 20 * DAY) });

  // u2: FREE, trial expired
  const u2 = await makeStoreSpyUser(prisma, { email: `ps-free-expired-${randomUUID().slice(0, 6)}@t.local`, plan: "FREE", freeTrialEndsAt: new Date(now.getTime() - 5 * DAY) });
  await prisma.cpSubscription.updateMany({ where: { id: `subt_${u2.id}` }, data: { periodEnd: new Date(now.getTime() - 5 * DAY) } });

  // u3: BASIC, perpetual (admin-set style)
  await makeStoreSpyUser(prisma, { email: `ps-basic-perp-${randomUUID().slice(0, 6)}@t.local`, plan: "BASIC" });

  // u4: BUSINESS, perpetual
  await makeStoreSpyUser(prisma, { email: `ps-business-perp-${randomUUID().slice(0, 6)}@t.local`, plan: "BUSINESS" });

  // u5: BASIC, paid period_end in the future
  const u5 = await makeStoreSpyUser(prisma, { email: `ps-basic-future-${randomUUID().slice(0, 6)}@t.local`, plan: "BASIC" });
  await syncControlPlanePlan(prisma, { userId: u5.id, plan: "BASIC", trialEndsAt: null, paidPeriodEnd: new Date(now.getTime() + 30 * DAY) });

  // u6: BASIC on the shadow row, but paid period_end already PAST (lapsed, sweep hasn't run)
  const u6 = await makeStoreSpyUser(prisma, { email: `ps-basic-lapsed-${randomUUID().slice(0, 6)}@t.local`, plan: "BASIC" });
  await syncControlPlanePlan(prisma, { userId: u6.id, plan: "BASIC", trialEndsAt: null, paidPeriodEnd: new Date(now.getTime() - 2 * DAY) });

  return { lapsedUserId: u6.id };
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/test/i.test(url)) throw new Error(`DATABASE_URL not a test DB: ${url}`);

  await prisma.$executeRawUnsafe(`TRUNCATE "Session","Account","User" RESTART IDENTITY CASCADE`);
  await resetControlPlane(prisma);

  const { lapsedUserId } = await seed();

  // The seeded subs were written by writeStoreSpySubscriptions(), which does
  // not set plan_slug yet — they are NULL. Run the migration's backfill.
  const filled = await prisma.$executeRawUnsafe(BACKFILL_SQL);
  console.log(`backfill UPDATE touched ${filled} subscription row(s)\n`);

  const users = await prisma.user.findMany({ select: { id: true, email: true, plan: true } });
  console.log(`Checking ${users.length} users (now = ${new Date().toISOString()})\n`);

  const bad: string[] = [];
  const gap: string[] = [];
  const inferenceDisagree: string[] = [];
  let ok = 0;

  for (const u of users) {
    const subs = await prisma.cpSubscription.findMany({
      where: { accountId: `acct_${u.id}` },
      select: { id: true, planSlug: true },
    });
    const distinct = [...new Set(subs.map((s) => s.planSlug))];
    const columnSlug = distinct.length === 1 ? distinct[0] : undefined;
    const inferred = await resolvePlanSlug(prisma, u.id);

    if (subs.length === 0 || columnSlug === undefined || columnSlug === null) {
      gap.push(`  ${u.email} (${u.id})  subs=${JSON.stringify(subs)}`);
      continue;
    }
    if (columnSlug !== u.plan) {
      bad.push(`  ${u.email} (${u.id})  plan_slug=${columnSlug}  store_spy.User.plan=${u.plan}`);
      continue;
    }
    if (inferred !== columnSlug) {
      inferenceDisagree.push(`  ${u.email} (${u.id})  plan_slug=${columnSlug}=User.plan  resolvePlanSlug()=${inferred}`);
      continue;
    }
    ok++;
  }

  console.log(`OK (all three agree):        ${ok}/${users.length}`);
  console.log(`BACKFILL GAP:                ${gap.length}`);
  gap.forEach((l) => console.log(l));
  console.log(`BAD BACKFILL:                ${bad.length}`);
  bad.forEach((l) => console.log(l));
  console.log(`INFERENCE DISAGREES:         ${inferenceDisagree.length}`);
  inferenceDisagree.forEach((l) => console.log(l));

  const expectedLapsed = inferenceDisagree.some((l) => l.includes(lapsedUserId));
  console.log(
    `\nseeded lapsed-paid user ${lapsedUserId} classified as INFERENCE DISAGREES: ${expectedLapsed ? "yes (expected)" : "NO — unexpected"}`,
  );

  if (bad.length > 0 || gap.length > 0) {
    console.log("\nFAIL — backfill is wrong or incomplete.");
    process.exitCode = 1;
  } else if (inferenceDisagree.length > 0) {
    console.log(
      "\nPASS with notes — backfill is correct everywhere; the INFERENCE DISAGREES rows above are accounts whose\n" +
        "subscription state maps to no tier under the quota/status inference (lapsed paid period_end, not yet swept).\n" +
        "Decide how resolvePlanSlug() should treat these once it reads plan_slug (see the commit-3 plan).",
    );
  } else {
    console.log("\nPASS — plan_slug agrees with store_spy.User.plan and with resolvePlanSlug() for every user.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
