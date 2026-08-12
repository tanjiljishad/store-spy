/**
 * Runs one scheduler tick locally: claims due stores, crawls each, persists.
 * For local dev / OS-level cron. Production (e.g. Vercel Cron) should hit
 * POST /api/internal/scheduler/tick instead — same runSchedulerTick()
 * underneath, just reachable over HTTP with the secret header cron sends.
 */
import { prisma } from "../src/lib/db/prisma";
import { runSchedulerTick } from "../src/lib/monitoring/scheduler";

async function main() {
  const result = await runSchedulerTick({ prisma });
  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
