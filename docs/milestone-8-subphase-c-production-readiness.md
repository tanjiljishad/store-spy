# Milestone 8 Sub-phase C — Production Readiness Checklist

Every item below carries a status of **PASS**, **FAIL**, **BLOCKED**, **UNVERIFIED**, or
**NOT APPLICABLE**, with the concrete evidence behind it. No item is marked PASS on the
strength of "should work" or "tests pass" alone — see the final chat response for this
sub-phase for the full narrative summary.

## Infrastructure

| Item | Status | Evidence |
|---|---|---|
| Hosting account (Render) | BLOCKED | No credentials in this environment; user chose to proceed without cloud deployment. |
| Managed Postgres account (Neon) | BLOCKED | Same reason. |
| Deployment configuration exists | PASS | `render.yaml` (web + worker services), `docs/staging-deployment.md`. |
| Node version pinned | PASS (fixed this sub-phase) | `package.json` had no `engines` field — added `">=20.9.0"`, matching Next.js 16's own documented minimum. |

## Database

| Item | Status | Evidence |
|---|---|---|
| Real managed Postgres | BLOCKED | No Neon/Supabase account. |
| Migration-driven deploy (`prisma migrate deploy`, not `db push`) | PASS | Re-verified this sub-phase: 8 migrations applied cleanly to a fresh local Postgres, zero pending. `render.yaml`'s `preDeployCommand` uses `migrate deploy`. |
| Schema unchanged | PASS | No `prisma/schema.prisma` edit this sub-phase. |
| UTC timestamp discipline | PASS | `timezone-safety.integration.test.ts` (both monitoring and marketing) re-run against real Postgres, passing. |
| Connection pooling under real load | BLOCKED | Requires real managed Postgres / real concurrent production traffic; not fabricated. |

## Web

| Item | Status | Evidence |
|---|---|---|
| Builds in a clean environment | PASS | `npm run build` — clean, zero errors, zero warnings. |
| Starts in real production mode | PASS | `next start` with `NODE_ENV=production` against real Postgres — confirmed via `curl` and a real browser. |
| Landing page loads | PASS | Real browser + `curl` (8ms local response time). |
| API routes work | PASS | `/api/analyze`, `/api/dashboard`, `/api/auth/*`, `/api/store/[domain]/*` all exercised for real this sub-phase. |
| SSE works | PASS | Real `POST /api/analyze` SSE stream observed end-to-end (colourpop.com, 9.4s full analysis). |
| Authentication works (Credentials) | PASS (after a real, fixed bug) | See "Authentication" section below. |
| Dashboard / Store Intelligence render correctly | PASS | Real browser screenshots, desktop + mobile, zero console errors. |
| Health check path | PASS (design confirmed, not newly built) | `render.yaml` uses `/` (static, no DB dependency) — appropriate for "is the process alive" checks. |

## Worker

| Item | Status | Evidence |
|---|---|---|
| Starts and connects to Postgres | PASS | Real local runs throughout this sub-phase. |
| Executes Shopify scheduler tick | PASS | Real 4-store mixed batch: `claimed:4, succeeded:3, failed:1`. |
| Executes marketing scheduler tick | PASS | Two real SerpApi calls, both `outcome: SUCCESS`. |
| Runs stale-crawl sweep | PASS | Re-confirmed via the full integration suite (8 dedicated tests, real Postgres) — not re-exercised live this sub-phase since Sub-phase B already did so end-to-end. |
| Restarts cleanly, no duplicate work | PASS | Killed mid-cycle-boundary and restarted; next cycle correctly claimed nothing already-processed (`claimed:0` for stores whose `nextCrawlAt` was already pushed forward). |
| Graceful `SIGTERM`/`SIGINT` handling | UNVERIFIED | Same platform limitation Sub-phase B found: this Windows machine has neither Docker nor WSL available, so genuine POSIX signal delivery to a single supervised process cannot be tested here. The code itself is the standard, correct Node.js pattern. Requires the real Linux staging host. |
| 5-minute tick cadence appropriate | PASS (reasoning re-confirmed) | Comfortably below the 10-minute claim-timeout and the 8-hour fastest real cadence; unaffected by this sub-phase's changes. |

## Scheduler

| Item | Status | Evidence |
|---|---|---|
| Case A — no due stores | PASS | Multiple real empty-batch cycles observed, 70-81ms each. |
| Case B — one due store | PASS (subsumed by Case C) | See mixed-batch result below. |
| Case C — multiple due stores, `SKIP LOCKED` | PASS | 4-store real batch, no double-claim. |
| Case D — one store fails, others continue | PASS | Unreachable domain failed (`DNS resolution failed`) while 3 real stores succeeded in the same batch. |
| Case E — worker crash/restart | PASS | See "Worker" section. |

## Shopify crawler

| Item | Status | Evidence |
|---|---|---|
| Real external crawl succeeds | PASS | allbirds.com (291 products/2 pages), colourpop.com (1,041 products/5 pages — real catalog growth since Sub-phase B's 1,032), taylorstitch.com (3,778 products/16 pages). |
| Response-size cap doesn't false-positive on real large pages | PASS | taylorstitch.com's 16-page crawl completed cleanly under the 10MB default. |
| Failure isolated per-store | PASS | Unreachable domain failed independently, `failureStreak` incremented to 1, tier unchanged (correct single-failure behavior, no premature demotion). |
| SSRF protection intact | PASS | Full `crawl/shopify.ts` test suite (including SSRF-guard tests) re-run against this sub-phase's code — no regression. Guard re-read directly: still called on every redirect hop. |

## Marketing intelligence

| Item | Status | Evidence |
|---|---|---|
| Runs independently of Shopify crawling | PASS | Confirmed by code structure (separate try/catch phase in `worker.ts`) and by the mixed-batch test, where marketing was deliberately suppressed via a future `nextMarketingCollectionAt` without affecting the Shopify phase. |
| Vendor failure doesn't kill the worker | PASS | Existing `marketing_scheduler.tick_failed` catch-and-log path, unchanged; re-confirmed by code read. |
| `MarketingCollectionRun`/`AdObservation` persistence | PASS | Real run: `outcome: SUCCESS, adsObserved: 80, vendorRequestCount: 82`, 80 real `AdObservation` rows persisted. |
| Duplicate collection prevented | PASS | `nextMarketingCollectionAt` claim-push mechanism unchanged; `marketingBaselinedAt` correctly set on first success. |

## SerpApi

| Item | Status | Evidence |
|---|---|---|
| Real authenticated request succeeds | PASS | Two real calls this sub-phase, both `SUCCESS`. |
| Request duration measured | PASS, **highly variable** | Call 1 (cold, Sub-phase B): 236,769ms. Call 2 (this sub-phase, same domain, shortly after): 394ms — almost certainly a vendor-side cache hit. Treat as a wide latency distribution, not a fixed number. |
| Timeout behavior | PASS (code-reviewed, not forced this sub-phase) | `fetchJson`'s own `AbortController` timeout, unchanged, already unit-tested. |
| Retry behavior | PASS (code-reviewed) | One retry on a transient failure, unchanged. |
| Failure behavior | PASS (code-reviewed, real success path only exercised live) | `describeNetworkError` empirically confirmed (Sub-phase B) to never leak the API key even on a real failure. |
| Cost per request | UNVERIFIED | No SerpApi billing dashboard access from this environment. |

## Authentication

| Item | Status | Evidence |
|---|---|---|
| Credentials signup/login/logout | PASS | Real browser session: signup → authenticated session cookie confirmed via `/api/auth/session` → logout clears it. Desktop + mobile. |
| Session persistence across pages | PASS | Dashboard, Store Intelligence, full report all reachable post-signup without re-authenticating. |
| Protected routes enforce authentication | PASS | `/api/dashboard`, `/api/store/[domain]/watch` both return 401 without a session (code-reviewed; existing tests unchanged and passing). |
| **Production-mode `UntrustedHost` bug** | **FOUND AND FIXED** | Every Auth.js endpoint failed closed in real `next start` without `AUTH_TRUST_HOST=true`. Reproduced, root-caused (`@auth/core`'s `setEnvDefaults`), fixed (env var, not a code change), and re-verified via `curl` and a full real-browser journey. See the completion report for the full story. |
| Google OAuth | **NOT VERIFIED** | No real Google OAuth app credentials exist in this environment. App runs correctly without them (button simply doesn't render). |
| Facebook OAuth | **NOT VERIFIED** | Same reason. |

## Entitlements

| Item | Status | Evidence |
|---|---|---|
| FREE: 3 unique analyses, duplicate re-analysis free | PASS | `plan-limits.ts` unchanged; `analysis-usage.integration.test.ts` re-run, passing; visually confirmed in a real browser (dashboard showed `0/3`). |
| FREE: 1 monitored store, 30-day expiry | PASS | Same file, same tests; dashboard showed `0/1`. |
| BASIC: unlimited analyses, 20 monitors, no expiry | PASS | `watch.integration.test.ts`'s 20-monitor test re-run, passing. |
| Entitlement logic centralized | PASS | `entitlement-service.ts` confirmed (by code read) to be the sole place `plan` becomes a permission decision; the only other `plan` string comparisons found are UI copy/label branches, not permission gates. |
| No hardcoded plan checks outside entitlement logic | PASS | Repo-wide grep confirmed. |

## Security

| Item | Status | Evidence |
|---|---|---|
| Secrets not exposed client-side | PASS | Grepped the built static bundle (`.next/static/`) for `postgresql://`, `SCHEDULER_SECRET`, `AUTH_SECRET` — none found. |
| `.env`/`.env.test` not committed | PASS | Re-confirmed (`git log --all -- .env .env.test`, empty). |
| Scheduler routes fail closed | PASS | Code unchanged from Sub-phase B, re-read this sub-phase. |
| Watchlist authorization is user-scoped | PASS | `startMonitoring`/`stopMonitoring` both scope by `userId` (composite key lookup / `updateMany` where-clause), confirmed by direct code read. |
| Report access correctly gated by entitlement, not by ownership-that-doesn't-exist | PASS | `/api/store/[domain]/report` returns full detail only when `hasAnalyzedStore(userId, storeId)`; anonymous/unanalyzed callers get a truncated preview. Store intelligence itself is shared corpus data, not per-user private data, by design. |
| No debug/test-only routes exposed | PASS | `find src/app/api -iname "*debug*" -o -iname "*test*"` — empty. |
| Repo-wide secret-pattern sweep | PASS | Empty, including a targeted check that the real SerpApi key value discovered during this sub-phase's own investigation was never written into any file. |

## Browser

| Item | Status | Evidence |
|---|---|---|
| Desktop full journey | PASS | 8/8 steps, real production build, zero console/page errors (`net::ERR_ABORTED` on RSC prefetches is standard Next.js behavior, not an error). |
| Mobile full journey | PASS | Same, 8/8 steps. |
| No Fable UI regression | PASS | Screenshots visually confirmed dark theme, typography, amber accent, card layout unchanged. |

## Performance

| Item | Status | Evidence |
|---|---|---|
| Landing page response time | OBSERVED (local) | 8ms. |
| Dashboard response time | OBSERVED (local) | 162ms (unauthenticated redirect). |
| Store report API | OBSERVED (local) | 209ms. |
| SSE analyze, full duration | OBSERVED (local) | 9.4s (1,041-product store, full analysis incl. theme/apps/bestseller). |
| Scheduler tick, 4-store real batch | OBSERVED (local) | 28.87s. |
| SerpApi request duration | OBSERVED (local), highly variable | 394ms–236,769ms across 2 real samples. |
| Real cloud/production network topology | UNVERIFIED | Requires actual Render↔Neon↔Shopify network paths; local measurements are not a substitute. |

## Logging

| Item | Status | Evidence |
|---|---|---|
| Structured worker/web logs reviewed | PASS (local logs only) | Every log line from this sub-phase's real runs reviewed; no secret, no credential, no raw error dump beyond documented-safe fields. |
| Real cloud log aggregation | BLOCKED | No cloud deployment exists. |

## Recovery

| Item | Status | Evidence |
|---|---|---|
| Web process restart | PASS | Killed and restarted; DB data intact (3 users, 4 stores confirmed before/after); landing page and auth endpoints recovered immediately. |
| Worker restart | PASS | See "Worker" section. |
| Database temporary failure | NOT APPLICABLE THIS SUB-PHASE | Not safely testable without risking the shared local disposable instance mid-suite; existing retry/backoff logic unchanged from prior sub-phases. |
| SerpApi failure isolation | PASS (code-reviewed) | Unchanged `marketing_scheduler.tick_failed` catch path; not forced live this sub-phase (both real calls succeeded), but code path already covered by existing integration tests (`scheduler.integration.test.ts`'s "one store's unexpected exception..." case). |
| Shopify crawl failure isolation | PASS | Real, live: the unreachable-domain failure did not affect the other 3 real stores in the same batch. |

## Cost

| Item | Status | Evidence |
|---|---|---|
| Real hosting cost | BLOCKED/PROJECTED only | No deployment; Sub-phase A's ~$14/mo (2× Render `starter`) carried forward as an estimate, not a measurement. |
| Real database cost | BLOCKED/PROJECTED only | Same reason. |
| SerpApi cost | UNVERIFIED (dollar amount) | 2 real calls consumed this sub-phase (on top of Sub-phase B's 1), OBSERVED as real usage; exact billing amount not accessible from this environment. |

## Deployment process

| Item | Status | Evidence |
|---|---|---|
| `render.yaml` present and accurate | PASS | Updated this sub-phase (`AUTH_TRUST_HOST` added to web; `AUTH_SECRET` correctly removed from worker after verifying it's unnecessary). |
| `docs/staging-deployment.md` reflects real findings | PASS | Updated this sub-phase with the `AUTH_TRUST_HOST` bug and its fix, plus a "what's already verified locally" section. |
| Rollback procedure documented | UNVERIFIED/DEFERRED | No real deployment exists to roll back from; Render's own dashboard-based rollback (redeploy a prior commit) is standard platform behavior, not something this repo needs to implement, but has not been exercised. |

---

## STOP conditions

**None were triggered.** The SerpApi latency variance (236,769ms vs. 394ms across two real
samples) was evaluated against STOP 9 ("SerpApi latency causes unacceptable worker starvation or
scheduler failure") and does not qualify: the worker's sequential-phase design means a slow
marketing phase delays the *start* of the next cycle, never the current cycle's Shopify crawling,
and nothing crashed, corrupted, or got permanently stuck. It is a real capacity-planning
consideration (documented above and in the completion report) that would matter more at a larger
number of simultaneously-due monitored stores than this product currently has — not a STOP
condition today.

## Recommendation

**MORE STAGING VALIDATION REQUIRED** — specifically, the two items that are genuinely UNVERIFIED
rather than merely BLOCKED-by-missing-credentials: graceful worker shutdown under real POSIX
signals, and real Render↔Neon network/connection-pool behavior. Everything else this sub-phase
could verify locally — including a real, previously-undiscovered production-breaking authentication
bug — was verified and, where broken, fixed. The application is not yet demonstrated to survive a
real cloud deployment, because no real cloud deployment has occurred; it is demonstrated to survive
every failure mode this local environment could genuinely reproduce.
