/**
 * Runs one marketing-collection scheduler tick locally: claims stores due
 * for a Google-ads check, collects each, persists. For local dev / OS-level
 * cron. Production (e.g. Vercel Cron) should hit
 * POST /api/internal/scheduler/marketing-tick instead — same
 * runMarketingSchedulerTick() underneath. Deliberately a separate script
 * from scheduler-tick.ts (the Shopify crawler), not a shared one.
 */
import { prisma } from "../src/lib/db/prisma";
import { runMarketingSchedulerTick } from "../src/lib/marketing/scheduler";
import { getConfiguredMarketingSource } from "../src/lib/marketing/source-factory";

async function main() {
  const source = getConfiguredMarketingSource();
  const result = await runMarketingSchedulerTick({ prisma, source });
  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
