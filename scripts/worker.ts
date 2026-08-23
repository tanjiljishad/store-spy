/**
 * The production worker process — Milestone 8 Sub-phase B.
 *
 * Responsibility: periodically run the EXISTING Shopify scheduler tick, the
 * EXISTING marketing scheduler tick, and the stale-crawl sweep, calling
 * each function directly (worker → function), never through the HTTP
 * scheduler routes (worker → HTTP → function) — there is no compelling
 * reason for that extra hop when this process already has direct access to
 * Prisma and every domain function the HTTP routes themselves call. Those
 * routes (`POST /api/internal/scheduler/tick`, `.../marketing-tick`) remain
 * useful as a manual-trigger/health-check surface for a human operator or
 * an external monitor — this worker does not replace them, it just doesn't
 * need them for its own normal cadence.
 *
 * This is the ONLY worker process this sub-phase deploys (single-process,
 * per the Sub-phase A research and this sub-phase's own Rule: "the first
 * production worker should be single-process"). It remains safe if a
 * second worker is ever introduced later — every claim this worker makes
 * goes through the existing `FOR UPDATE SKIP LOCKED` mechanism in
 * `monitoring/scheduler.ts`/`marketing/scheduler.ts`, already proven safe
 * under concurrent execution (see those modules' own integration tests) —
 * this script adds no new concurrency assumption of its own.
 *
 * Interval: see TICK_INTERVAL_MS below for the reasoning (a conservative
 * multiple below the scheduler's own 10-minute claim-timeout, comfortably
 * below the fastest real cadence in the system — HOT tier's 8 hours — so
 * polling overhead stays negligible relative to how rarely anything is
 * actually due).
 */
import { prisma } from "../src/lib/db/prisma";
import { runSchedulerTick } from "../src/lib/monitoring/scheduler";
import { runMarketingSchedulerTick } from "../src/lib/marketing/scheduler";
import { getConfiguredMarketingSource } from "../src/lib/marketing/source-factory";
import { sweepStaleCrawls } from "../src/lib/monitoring/stale-crawl-sweep";
import { sweepOldLoginAttempts } from "../src/lib/security/login-attempt-sweep";
import { expireDueSubscriptions } from "../src/lib/billing/subscription-sweep";
import { expirePendingCheckouts } from "../src/lib/billing/checkout";
import { sweepOldAnalysisUsage } from "../src/lib/entitlements/analysis-usage";
import { sweepOldAnonymousAnalyses } from "../src/lib/entitlements/anonymous-analysis";
import { expireDuePermissionGrants } from "../src/lib/admin/permissions-service";
import { computeAndStoreSnapshots } from "../src/lib/admin/analytics/snapshot";
import { dispatchPendingConversionEvents } from "../src/lib/marketing/conversion-events";

/**
 * How often the worker checks for due work. Chosen relative to two real
 * constants already in this codebase, not invented:
 *   - Comfortably BELOW the scheduler's own CLAIM_TIMEOUT_MS (10 minutes,
 *     monitoring/scheduler.ts) — a store's claim window is never at risk of
 *     lapsing between one poll and the next while its crawl is still running.
 *   - Comfortably BELOW the fastest real cadence in the system (HOT tier,
 *     8 hours for Shopify crawls / 1 day for marketing collection,
 *     monitoring/policy.ts + marketing/policy.ts) — a 5-minute poll lags a
 *     newly-due HOT store by at most ~1% of its own cadence window, while
 *     keeping the claim query (a single indexed `SELECT ... LIMIT 10 FOR
 *     UPDATE SKIP LOCKED`, trivial even when it finds nothing due) rare
 *     enough that "hammering Postgres" is not a real concern at this rate.
 */
const TICK_INTERVAL_MS = 5 * 60_000;

let shuttingDown = false;
let inFlight: Promise<void> | null = null;

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Structured, single-line JSON — see docs/environment-variables.md and
  // this sub-phase's completion report for exactly which fields are safe:
  // never a secret, never a credential, only operational counts/durations/
  // ids. `storeId`/`domain` are not secrets — they're the same data already
  // shown in the product's own UI.
  console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), event, ...fields }));
}

function logError(event: string, err: unknown, fields: Record<string, unknown> = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ level: "error", ts: new Date().toISOString(), event, message, ...fields }));
}

async function runOneCycle(): Promise<void> {
  const cycleStart = Date.now();
  log("worker.cycle_started");

  try {
    const tickStart = Date.now();
    const result = await runSchedulerTick({ prisma });
    log("scheduler.tick_completed", {
      durationMs: Date.now() - tickStart,
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
      expiredWatches: result.expiredWatches,
    });
  } catch (e) {
    // Never let one failing phase of the cycle stop the others — the
    // scheduler tick itself already isolates per-store failures
    // (monitoring/scheduler.ts's own try/catch per claimed store); this is
    // the same discipline one level up, isolating per-PHASE failures so a
    // crash in the Shopify tick still lets marketing/sweep run this cycle.
    logError("scheduler.tick_failed", e);
  }

  try {
    const source = getConfiguredMarketingSource();
    const tickStart = Date.now();
    const result = await runMarketingSchedulerTick({ prisma, source });
    log("marketing_scheduler.tick_completed", {
      durationMs: Date.now() - tickStart,
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed,
    });
  } catch (e) {
    // Includes the expected, non-alarming "SERPAPI_API_KEY is not
    // configured" case (getConfiguredMarketingSource()'s own fail-closed
    // error) — logged once per cycle at this same level rather than
    // special-cased, since a misconfigured/missing vendor key in a real
    // deployment IS worth seeing in the logs, just never fatal to the rest
    // of the worker.
    logError("marketing_scheduler.tick_failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await sweepStaleCrawls(prisma);
    log("stale_crawl_sweep.completed", { durationMs: Date.now() - sweepStart, recovered: result.recovered });
  } catch (e) {
    logError("stale_crawl_sweep.failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await sweepOldLoginAttempts(prisma);
    log("login_attempt_sweep.completed", { durationMs: Date.now() - sweepStart, deleted: result.deleted });
  } catch (e) {
    logError("login_attempt_sweep.failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await expireDueSubscriptions(prisma);
    log("subscription_expiry_sweep.completed", {
      durationMs: Date.now() - sweepStart,
      expired: result.expiredCount,
      watchesExpired: result.watchesExpiredCount,
    });
  } catch (e) {
    logError("subscription_expiry_sweep.failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await expirePendingCheckouts(prisma);
    log("pending_checkout_sweep.completed", { durationMs: Date.now() - sweepStart, expired: result.expiredCount });
  } catch (e) {
    logError("pending_checkout_sweep.failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await sweepOldAnalysisUsage(prisma);
    log("analysis_usage_sweep.completed", { durationMs: Date.now() - sweepStart, deleted: result.deletedCount });
  } catch (e) {
    logError("analysis_usage_sweep.failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await sweepOldAnonymousAnalyses(prisma);
    log("anonymous_analysis_sweep.completed", { durationMs: Date.now() - sweepStart, deleted: result.deletedCount });
  } catch (e) {
    logError("anonymous_analysis_sweep.failed", e);
  }

  try {
    const sweepStart = Date.now();
    const result = await expireDuePermissionGrants(prisma);
    log("permission_grant_expiry_sweep.completed", { durationMs: Date.now() - sweepStart, expired: result.expiredCount });
  } catch (e) {
    logError("permission_grant_expiry_sweep.failed", e);
  }

  try {
    // Milestone 12 Section 3.2: safe to call every 5-minute cycle — the
    // function itself self-gates to an hourly cadence (see
    // analytics/snapshot.ts's own doc comment), so most cycles here are a
    // single cheap MAX(computedAt) lookup, not a real recompute.
    const snapshotStart = Date.now();
    const result = await computeAndStoreSnapshots(prisma);
    log("analytics_snapshot.completed", { durationMs: Date.now() - snapshotStart, computed: result.computed, rowsWritten: result.rowsWritten });
  } catch (e) {
    logError("analytics_snapshot.failed", e);
  }

  try {
    // Milestone 12 §4.2 Step 2: the ONE place any marketing vendor's
    // server-side conversion API is ever actually called — never the
    // request path. Safe to call every cycle even with zero vendors
    // configured (the current state, until §4.3 ships a real credential):
    // dispatchOne() marks each PENDING row SKIPPED_NO_CREDENTIAL rather
    // than looping forever on an unconfigured vendor.
    const conversionStart = Date.now();
    const result = await dispatchPendingConversionEvents(prisma);
    log("marketing_conversion_dispatch.completed", { durationMs: Date.now() - conversionStart, ...result });
  } catch (e) {
    logError("marketing_conversion_dispatch.failed", e);
  }

  log("worker.cycle_completed", { durationMs: Date.now() - cycleStart });
}

function scheduleNextCycle(): void {
  if (shuttingDown) return;
  setTimeout(() => {
    inFlight = runOneCycle()
      .catch((e) => logError("worker.cycle_crashed", e)) // belt-and-suspenders — runOneCycle already catches each phase
      .finally(() => {
        inFlight = null;
        scheduleNextCycle();
      });
  }, TICK_INTERVAL_MS);
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second SIGTERM/SIGINT while already shutting down is a no-op, not a double-exit race
  shuttingDown = true;
  log("worker.shutdown_requested", { signal });

  // Stop new work from being scheduled; let whatever's already running
  // finish naturally rather than aborting mid-crawl/mid-transaction, which
  // could leave a Crawl row RUNNING (recoverable by the sweep, but better
  // avoided) or worse, interrupt a persistence transaction Postgres itself
  // would otherwise complete atomically.
  if (inFlight) {
    log("worker.waiting_for_in_flight_cycle");
    await inFlight;
  }

  await prisma.$disconnect();
  log("worker.shutdown_complete");
  process.exit(0);
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

log("worker.starting", { tickIntervalMs: TICK_INTERVAL_MS });
inFlight = runOneCycle()
  .catch((e) => logError("worker.cycle_crashed", e))
  .finally(() => {
    inFlight = null;
    scheduleNextCycle();
  });
