# Milestone 8 Sub-phase B — Pre-Production Hardening, Worker, and Staging Preparation

Terminology used throughout, exactly as required: **OBSERVED** (measured directly, this
sub-phase), **VERIFIED** (a specific claim was tested and held), **UNVERIFIED** (not tested,
status genuinely unknown), **BLOCKED** (testing was attempted or planned but could not proceed —
reason stated), **PROJECTED** (an estimate, explicitly not a measurement), **DEFERRED**
(intentionally left for a later sub-phase).

---

## 1. Status

**Complete**, with one explicitly scoped exception: real cloud deployment (Render + Neon) is
**BLOCKED** — no hosting/database credentials exist in this development environment. Every other
requirement — the three hardening implementations, the worker, and infrastructure-equivalent
local verification (real Postgres, real Shopify crawls, the real worker process, a real browser
session) — was completed and verified against real systems, not just passing tests.

## 2. Objective

Close the three pre-production gaps Milestone 8 Sub-phase A identified (no stale-crawl recovery,
no crawler response-size cap, undocumented `SCHEDULER_SECRET`), add a thin production worker
process that runs the existing scheduler on a real cadence, and replace Sub-phase A's *inference*
about production behavior with real *measurement* wherever local infrastructure allows it —
explicitly not claiming the parts that require real cloud credentials.

## 3. Source research used

`docs/milestone-8-subphase-a-production-architecture-research.md` (all 32 sections; Sections 7,
11, 13, and 27 directly drove this sub-phase's scope) and this sub-phase's own live investigation
of the `Crawl` lifecycle, the crawler's HTTP layer, and the existing scheduler modules (Section 5,
below).

## 4. Files changed

- `src/lib/crawl/shopify.ts` — response-size cap, threaded through `fetchWithTimeout`/
  `readBodyWithLimit`; all 4 call sites updated. No SSRF/redirect logic touched.
- `.env.test.example` — `SCHEDULER_SECRET` documented.
- `package.json` — added `"worker": "tsx scripts/worker.ts"`. No dependency changes
  (`package-lock.json` untouched — confirmed via `git status`).

## 5. Files inspected (read, not modified)

`src/lib/monitoring/crawl-outcome.ts`, `src/lib/monitoring/run-scheduled-crawl.ts`,
`src/lib/monitoring/scheduler.ts`, `src/lib/marketing/scheduler.ts`,
`src/lib/marketing/sources/google-serpapi.ts`, `src/lib/diff/persist.ts`,
`src/lib/monitoring/__tests__/scheduler.integration.test.ts`,
`src/lib/monitoring/__tests__/timezone-safety.integration.test.ts`,
`src/lib/crawl/__tests__/shopify.test.ts`, `prisma/schema.prisma`, `.env`, `.env.test`.

## 6. Schema changes

**None.** Confirmed by running `prisma migrate deploy` against a freshly created database this
sub-phase: exactly the same 8 pre-existing migrations applied, zero new, zero pending. The
stale-crawl sweep uses a plain typed `prisma.crawl.updateMany()` — no new columns, no new tables,
no raw SQL.

## 7. Migration details

Not applicable — no migration was added. The 8 existing migrations
(`20260809004235_init` through `20260811230000_growth_signals_event_index`) were re-applied
cleanly to a brand-new database as part of this sub-phase's real-Postgres verification, confirming
they remain valid and complete on their own.

## 8. Stale crawl sweep

**Implementation**: `src/lib/monitoring/stale-crawl-sweep.ts`, `sweepStaleCrawls(prisma, now,
thresholdMs)`. A `Crawl` row is created `RUNNING` at the start of both manual and scheduled crawls
and only reaches a terminal status at the end of a successful function call — nothing previously
revisited an orphaned row if its owning process died mid-crawl. The sweep closes exactly that gap
with a plain typed `updateMany` (`WHERE status = 'RUNNING' AND startedAt < cutoff`), setting
`status: FAILED`, `finishedAt: now`, and an explanatory `errorMessage`. Threshold:
`STALE_CRAWL_THRESHOLD_MS = 30 minutes`, justified against Sub-phase A's own real-world crawl-
duration analysis (worst case a few minutes) — comfortable headroom, not an arbitrary number.

Deliberately does **not** call `applyCrawlFailureToStore()` or touch `Store.failureStreak`/`tier`
— a worker crash is an infrastructure event, not evidence the *store* is unreachable, and must
never demote a healthy store toward `DISABLED`.

**VERIFIED** three independent ways:
- 8 integration tests (`stale-crawl-sweep.integration.test.ts`): recovers stale, leaves fresh
  untouched, exact-boundary correctness, idempotent on repeat, concurrency-safe (two simultaneous
  sweeps via `Promise.all` never double-process), never touches an unrelated completed crawl,
  recovers `MANUAL`-triggered crawls identically to `SCHEDULED`, and stays correct under a
  non-UTC session timezone (`Asia/Kathmandu`, UTC+5:45) — all 8 passed against real Postgres.
- **OBSERVED live, end-to-end, through the real worker process**: seeded a real due store
  (allbirds.com) plus a hand-backdated 45-minute-old orphaned `RUNNING` crawl, started
  `scripts/worker.ts` for real, and confirmed the orphaned row was recovered to `FAILED` with the
  exact expected `errorMessage`, in the same cycle that also ran a real Shopify crawl for the due
  store — proving the sweep works inside the actual worker, not only inside its own isolated test.
- No raw SQL used, so the `AT TIME ZONE 'UTC'` discipline doesn't apply here by construction; the
  non-UTC-session test still exists per this project's standing convention.

## 9. Response-size cap

**Implementation**: enforced at the transport/body-consumption boundary, not via
`response.text().length` (explicitly prohibited by the brief and avoided). `fetchWithTimeout` now
returns `{ response, controller, timer }`; a new `readBodyWithLimit()` checks `Content-Length` for
a fast rejection when present, then streams the body via `response.body.getReader()`, counting
bytes as they arrive and calling `controller.abort()` + `reader.cancel()` the instant the running
total exceeds the cap — the same `AbortController` the request's own timeout already uses, so one
signal governs both. `DEFAULT_MAX_RESPONSE_BYTES = 10 MB`, chosen generously above every real
Shopify page size observed this session (the largest real page fetched, taylorstitch.com's
3,778-product/16-page catalog, stayed well under it).

A size violation on an otherwise-200 response reuses the *existing* `classifyFirstPageFailure()`
branching (falls into `not_found`, since the failure carries the real 200 status) rather than
inventing a new failure category — per the brief's "reuse existing classification" instruction.

**VERIFIED**: 8 new unit tests (normal-below-limit, exactly-at-limit, one-byte-over, declared
`Content-Length` over the cap, chunked/no-`Content-Length` exceeding the cap mid-stream, malformed
`Content-Length`, abort-signal correctness, and a realistic 250-product page staying under the
real default) — all passing, plus all 26 pre-existing `shopify.test.ts` tests unmodified and still
passing, proving this was a behavior-preserving refactor. **OBSERVED live**: two real Shopify
crawls this sub-phase (allbirds.com, 291 products/2 pages; taylorstitch.com, 3,778 products/16
pages) both completed successfully through the real cap-enforcing code path with zero false
positives.

## 10. SCHEDULER_SECRET documentation

Added to `.env.example` (new), `.env.test.example`, and a new evergreen reference,
`docs/environment-variables.md`, covering all 8 effective environment variables in a table (what
each protects, who reads it, required/optional per environment). `SCHEDULER_SECRET`'s row answers
the brief's exact checklist: it protects `POST /api/internal/scheduler/tick` and `.../marketing-
tick` (both fail closed, HTTP 503, if unset); the worker does **not** use it (calls the scheduler
functions directly, in-process); required in staging/production only if those HTTP routes are
ever manually triggered; generate via `openssl rand -base64 32`. No real secret value appears in
any committed file — confirmed by `git log --all -- .env .env.test` (empty) and a repo-wide grep
for common secret patterns (empty).

## 11. Worker architecture, entrypoint, and lifecycle

`scripts/worker.ts`. Startup: logs `worker.starting`, immediately runs one cycle, then
self-reschedules via `setTimeout` (not `setInterval`, to avoid overlapping-cycle pile-up if one
runs long). Each cycle runs, in order, inside independent try/catch blocks so one phase's failure
never blocks the others: `runSchedulerTick()`, `runMarketingSchedulerTick()` (skipped gracefully
via a logged failure if `SERPAPI_API_KEY` is unset — the existing fail-closed design, not new),
`sweepStaleCrawls()`. Every phase logs a single structured JSON line
(`{level, ts, event, ...fields}`) with counts and durations; **never** a secret (verified in the
security review, Section 24).

Graceful shutdown: `SIGTERM`/`SIGINT` handlers stop scheduling *new* cycles, await any in-flight
cycle to finish naturally (never force-abort — the docs explicitly note this must not corrupt a
mid-transaction crawl), disconnect Prisma, exit 0.

**Interval**: `TICK_INTERVAL_MS = 5 minutes` — comfortably below the scheduler's own 10-minute
claim-timeout and the fastest real cadence in the system (HOT tier, 8 hours), so polling overhead
stays negligible. Documented in the file itself, not invented arbitrarily.

**Calls the existing scheduler functions directly** — `runSchedulerTick`, `runMarketingSchedulerTick`,
`sweepStaleCrawls` — never through the HTTP routes, per the brief's explicit instruction. The HTTP
routes remain available for manual/operational triggering, unchanged.

## 12. Worker concurrency

Single process, single instance — the only one deployed this sub-phase, per the brief. Safety
under a *second* worker (should one ever be added) rests entirely on the pre-existing `FOR UPDATE
SKIP LOCKED` claim mechanism, unchanged by this sub-phase. This was not just assumed:
**OBSERVED, unintentionally but conclusively**, during local testing — two worker instances ended
up running concurrently against the same test database for several minutes (a Windows process-
termination artifact described in Section 20) and no double-claim, duplicate crawl, or duplicate
marketing collection occurred. A separate, deliberate test reinforced the same property: a real
scheduler tick with two claimed stores in one batch, one genuinely unreachable and one real
(colourpop.com), produced `claimed: 2, succeeded: 1, failed: 1` — the bad store's failure never
touched the good one.

## 13. Scheduler behavior

Unchanged. `runSchedulerTick`/`runMarketingSchedulerTick`, the tier/cadence/retry policy, and the
`FOR UPDATE SKIP LOCKED` claim mechanism were not modified this sub-phase — only called from a new
caller (the worker) and swept up-front by the new stale-crawl recovery. All pre-existing
integration tests for these modules (`scheduler.integration.test.ts`,
`marketing/scheduler.integration.test.ts`, including their concurrent-claim and
one-bad-store-doesn't-poison-the-batch tests) pass unmodified.

## 14. Staging architecture

```
INTERNET → Render Web Service (Next.js, npm run start) → Neon Postgres (managed, pooled)
                                                                ^
                                             Render Worker Service (npm run worker)
```

No queue, no Redis, no separate analytics database — exactly Sub-phase A's Option B, now expressed
as a concrete, deployable Render Blueprint (`render.yaml`) rather than a research recommendation.

## 15. Hosting decision

**Render** (web + worker services) — chosen concretely over the equally-valid Fly.io alternative
Sub-phase A left open, per this sub-phase's instruction to commit to one combination. Render's
native Blueprint format (`render.yaml`, committed) defines both services from one file, with a
`preDeployCommand` running `prisma migrate deploy` on the web service only (so exactly one process
applies migrations per deploy, never a race between two).

## 16. Database decision

**Neon** — chosen over the equally-valid Supabase alternative, for its bundled connection pooling
(the one real operational piece — PgBouncer — this codebase would otherwise need to run itself,
per Sub-phase A Section 27).

## 17. Environment variables

Full reference: `docs/environment-variables.md`. Staging-specific checklist:
`docs/staging-deployment.md`. Every variable is documented with what it protects, which
environments need it, and how to generate it; no real value appears in any committed file
(`render.yaml` uses `sync: false` for every secret — Render stores the real value only in its own
dashboard).

## 18. Real staging deployment

**BLOCKED.** No Render or Neon account/credentials exist in this development environment. Per the
brief's own explicit fallback instruction, actual cloud deployment was not attempted or claimed;
instead, `render.yaml` and `docs/staging-deployment.md` prepare the exact configuration, checklist,
and post-deploy verification steps for whoever next has real credentials to execute. Every
verification that does **not** require real cloud infrastructure was still completed in full
(Sections 8–13, 19–23) against a real, disposable, local Postgres instance and real outbound
network calls — this is not a substitute for staging, but it is real infrastructure verification,
not inference.

## 19. Real crawl results

Three real, live Shopify crawls this sub-phase, all through the real worker/scheduler code path
against real Postgres:

| Store | Products | Pages | Outcome | Notes |
|---|---|---|---|---|
| allbirds.com | 291 | 2 | OK | claimed-to-persisted in 3.18s |
| taylorstitch.com | 3,778 | 16 | OK | completed in ~7s despite an interrupted-shutdown attempt (Section 20) |
| colourpop.com | (existing catalog) | — | OK | run twice: once via a direct scheduler-tick invocation, once live through the browser (1,032 products visible in the UI) |
| this-domain-does-not-exist-abc123xyz.com | — | — | FAILED (`DNS resolution failed`) | deliberately unreachable, run in the same batch as colourpop.com to verify batch isolation (Section 12) |

No response-size, SSRF, or persistence irregularities in any of the above — **VERIFIED**.

## 20. Real scheduler results

**OBSERVED**: `runSchedulerTick` claim-to-completion for a single real store: 3.18s (allbirds.com).
A mixed batch (one real, one unreachable store): `claimed: 2, succeeded: 1, failed: 1`, isolated
correctly. A full worker cycle with nothing due: 70ms end-to-end (scheduler + marketing + sweep
phases).

**Notable finding — real marketing/SerpApi vendor latency**: one real `runMarketingSchedulerTick`
call (triggered incidentally when a freshly-baselined store became marketing-eligible) took
**236,769 ms (~3 minutes 57 seconds)** for a single store, far slower than Sub-phase A's implicit
assumption of an ordinary API-call-scale vendor latency. This did not break anything — the
worker's sequential-phase-then-reschedule design tolerates a slow phase gracefully, it simply
delays the start of the *next* cycle by that much — but it is a real, previously-unmeasured data
point worth carrying into capacity planning if the marketing batch size (currently 5, sequential)
is ever increased. Flagged in Section 29/31 as a monitoring item, not a correctness defect.

## 21. Worker restart results

**VERIFIED against real Postgres**, via the actual `scripts/worker.ts` process (not a simulation):
seeded a due store, started the worker, force-terminated it (the only reliable termination method
on this machine — see Section 20), confirmed via direct database query that no destructive or
duplicate side effect occurred, restarted the worker, and confirmed its first cycle resumed
cleanly: `claimed: 0` for both already-completed stores (their `nextCrawlAt`/
`nextMarketingCollectionAt` correctly left them not-yet-due), no errors, 70ms cycle. Combined with
the stale-crawl-sweep's own live verification (Section 8), this demonstrates the full restart
story: no permanently-stuck `RUNNING` state, no duplicate destructive work, normal resumption.

**Graceful `SIGTERM`/`SIGINT` handling specifically is UNVERIFIED on this local machine** — see
Section 27 for why, and why this does not undermine the result above.

## 22. Database measurements

**OBSERVED**: 8 pre-existing migrations applied cleanly to a fresh database with zero pending
(Section 6). Full integration suite (211 tests, 31 files) completed in 44.98s against real
Postgres with `connection_limit` unconstrained (default Prisma pooling) — no connection-exhaustion
symptoms at this test-suite concurrency level. No PgBouncer or connection-pool tuning was
introduced — none was needed, per the brief's "don't tune prematurely" instruction. Real
production connection behavior under Render/Neon's actual network topology remains **UNVERIFIED**
until Section 18 is unblocked.

## 23. Performance measurements

| Measurement | Value | Status |
|---|---|---|
| Full unit suite | 282 tests, 27 files, ~4-6s | OBSERVED |
| Full integration suite | 211 tests, 31 files, 44.98s | OBSERVED (real Postgres) |
| Single-store scheduler tick | 3.18s (allbirds.com) | OBSERVED |
| Empty-batch worker cycle | 70ms | OBSERVED |
| Real crawl, small store | 291 products/2 pages, part of the 3.18s above | OBSERVED |
| Real crawl, large store | 3,778 products/16 pages, ~7s | OBSERVED |
| Real SerpApi marketing call | 236,769ms for one store | OBSERVED (see Section 20 finding) |
| Render/Neon network latency, production topology | — | UNVERIFIED (Section 18 BLOCKED) |

## 24. Cost observations

**OBSERVED**: exactly one real SerpApi credit was consumed this sub-phase (incidentally, not
deliberately budgeted — see Section 20), within the brief's "a small number of real calls, not
intentionally consuming large numbers of credits" guidance. Exact dollar cost of that call:
UNVERIFIED (no SerpApi billing dashboard access from this environment).

**PROJECTED, not OBSERVED** (no real hosting billing has occurred): Render `starter` plan,
~$7/mo × 2 services (web + worker) ≈ $14/mo; Neon's free or lowest paid tier for a staging-scale
database. These figures are carried over from Sub-phase A's research, not newly measured — real
production cost remains genuinely unknown until Section 18 is unblocked and real usage
accumulates.

## 25. Security verification

- **Env vars/secrets**: `.env`/`.env.test` confirmed gitignored and never committed
  (`git log --all -- .env .env.test` empty); repo-wide grep for common secret patterns (AWS keys,
  private key blocks, credentialed Postgres URLs) found nothing.
- **Scheduler auth**: `/api/internal/scheduler/tick` and `.../marketing-tick` unchanged, still fail
  closed (503) when `SCHEDULER_SECRET` is unset, still reject a mismatched header (401).
- **Worker logs**: code-reviewed line by line — every `log()`/`logError()` call passes only event
  names, counts, durations, and (non-secret) domain/store identifiers already visible in the
  product's own UI. Never a credential, token, or API key.
- **Response-size cap**: error-reason strings (`"declared content-length N exceeds..."`,
  `"...exceeded the N-byte limit while streaming"`) contain only numbers, never response content.
- **SSRF**: `checkUrlIsSafeToFetch()` is still called on *every* redirect hop inside
  `fetchWithTimeout`'s loop (Section 9's refactor only changed what happens *after* a response is
  obtained, never the guard itself) — confirmed by direct code read.
- **Marketing vendor secret leakage**: `SERPAPI_API_KEY` is embedded in the outbound request URL
  as a query parameter; **empirically verified** (a real failing `fetch()` call against a
  nonexistent domain, api_key included in the URL) that Node's built-in fetch never includes the
  URL or query string in its thrown error's `.message` — only a generic `"fetch failed"` plus
  hostname in `.cause`, which this codebase's `describeNetworkError()` never reads. No leak path
  found; this is pre-existing code, not part of this sub-phase's changes, checked because the
  worker now surfaces these errors in its own logs.
- **Prod/staging separation**: `docs/environment-variables.md`'s "never shared between
  environments" list and `docs/staging-deployment.md`'s prerequisites both require separate
  `DATABASE_URL`/`AUTH_SECRET`/`SCHEDULER_SECRET`/`SERPAPI_API_KEY` per environment.
- **Auth cookies / OAuth / CORS**: not touched this sub-phase; out of scope per Rule 2.

No secret was found in any log line, error message, test snapshot, or committed file.

## 26. Browser verification

Real Playwright sessions (Chromium) at desktop (1440×900) and mobile (390×844) widths, against the
real dev server pointed at the same real Postgres instance used throughout this sub-phase.
Full flow: landing page → analyze (SSE) → report → signup → dashboard → authenticated re-analyze →
full report → Store Intelligence page (`/dashboard/stores/colourpop.com`) → dashboard revisit.
**Zero console errors or page errors** across all 12 flow steps at both widths. Screenshots
confirmed: Fable dark theme, typography, and amber accent color unchanged; Milestone 7's
Technology Stack section, three-part Growth Intelligence layout, and honest `Unavailable`-badged
Business Intelligence/Review Velocity/Advertising Intelligence cards all rendering correctly;
FREE-plan entitlements unchanged (3 unique stores, full intelligence unlocked; monitor 1 store free
for 30 days) — visually confirming Rule 3 held. Mobile layout stacks correctly with no overflow.

## 27. Tests

- **Unit**: 282/282 passing (27 files).
- **Integration**: 211/211 passing (31 files, real embedded Postgres), including all 8 new
  stale-crawl-sweep tests and zero regressions in every pre-existing suite (scheduler, crawl,
  timezone-safety, growth, marketing, auth, dashboard).
- **New this sub-phase**: `stale-crawl-sweep.integration.test.ts` (8 tests),
  `response-size-cap.test.ts` (8 tests) — both described in Sections 8–9.
- Existing tests were not weakened, skipped, or deleted.

## 28. Bugs found

1. **Local testing artifact, not a production bug**: on this Windows development machine, four
   independent process-termination mechanisms — Git Bash's `kill -TERM`, `kill -INT`, Node's own
   `process.kill(pid, 'SIGTERM')`, and the harness's own background-task stop — all failed to
   invoke `scripts/worker.ts`'s registered `SIGTERM`/`SIGINT` handlers, or in some cases to
   terminate the process at all. This matches Node.js's own documented Windows limitation
   (`SIGINT`/`SIGTERM`/`SIGKILL` cause *unconditional* termination on Win32, bypassing registered
   handlers entirely — only `SIGBREAK` gets real delivery). Only Windows-native `taskkill /F /T`
   reliably ended the process tree. This briefly caused two worker instances to run concurrently
   against the test database (Section 12) — harmless, since `FOR UPDATE SKIP LOCKED` handled it
   correctly, but worth recording as the reason graceful-shutdown itself is UNVERIFIED locally
   (Section 21/27).
2. No functional defects were found in any new production code (`stale-crawl-sweep.ts`,
   the response-size-cap refactor, or `worker.ts`) during real-infrastructure testing — all worked
   correctly on first live exercise, attributable to the unit/integration test coverage written
   before this real-verification phase.

## 29. Bugs fixed

None required — see Section 28. No regressions were introduced; all pre-existing tests continued
to pass unmodified throughout.

## 30. Known limitations

- Graceful `SIGTERM`/`SIGINT` shutdown in `scripts/worker.ts` is implemented using the standard,
  idiomatic Node.js pattern (code-reviewed, matches the brief's exact requirements: stop scheduling
  new work, await in-flight work, disconnect, exit 0) but **could not be exercised on this Windows
  development machine** (Section 28). It must be verified on the real Linux-based staging host
  once Section 18 is unblocked — Linux's standard POSIX signal delivery to a single supervised
  process does not share this limitation.
- Real marketing/SerpApi call latency (Section 20) was measured from a single sample; whether
  ~4 minutes is typical or an outlier needs more real staging samples before any scheduling
  assumption is revised.
- Real Render/Neon network latency, connection-pool behavior under production topology, and actual
  hosting/database cost are all UNVERIFIED/PROJECTED pending Section 18.

## 31. Unverified items

- Real cloud deployment (Section 18) — BLOCKED, no credentials.
- Graceful shutdown handler invocation (Section 28/30) — UNVERIFIED on this platform.
- Real OAuth (Google/Facebook) sign-in — **NOT VERIFIED**, no real OAuth app credentials exist in
  this environment; the app runs correctly without them (Credentials provider only), per existing,
  unchanged behavior.
- Exact real hosting/database/SerpApi dollar costs — PROJECTED only (Section 24).
- Whether Prisma's default connection pooling is adequate under real production concurrency
  (Section 22) — genuinely unknown without real load, deliberately not tuned preemptively.

## 32. STOP conditions

**None were triggered.** The one candidate considered — the real SerpApi call taking ~4 minutes
(Section 20) — was evaluated against the brief's STOP-condition list ("real vendor behavior
contradicting marketing-adapter assumptions") and judged not to qualify: nothing broke, no data
was corrupted, and the existing sequential-phase-then-reschedule worker design already tolerates
an arbitrarily slow phase without unsafe overlap. It is reported as a monitoring item (Sections 20,
30), not a STOP condition, per the instruction to report evidence rather than silently redesign
around it.

## 33. Deferred work

- Real cloud deployment and its full post-deploy verification checklist (`docs/staging-
  deployment.md`'s own checklist) — for whoever next has Render/Neon credentials.
- Real OAuth verification once real app credentials exist.
- Revisiting marketing scheduler batch size/cadence if further staging samples confirm the
  ~4-minute-per-store SerpApi latency (Section 20) is typical rather than an outlier — explicitly
  not changed this sub-phase, since one sample does not justify a design change.
- Billing/`Subscription` model (Sub-phase A's Phase E) — unchanged, out of scope, confirmed
  untouched.
- Choosing and installing an error-tracking/observability vendor (Sub-phase A's Phase G) —
  deliberately deferred; structured worker/log output was judged sufficient for this sub-phase.

## 34. Final response format

See the message accompanying this report.

## 35. Recommendation for Sub-phase C

Proceed to real cloud deployment (execute `docs/staging-deployment.md` against real Render and
Neon accounts) as the next concrete step — the architecture, worker, and both new hardening
pieces are code-complete and verified against every real system available locally. Sub-phase C's
first priority should be working through `docs/staging-deployment.md`'s post-deploy checklist,
with particular attention to the two items this sub-phase could not verify locally: graceful
worker shutdown under real POSIX signal delivery, and real Render-to-Neon network/connection-pool
behavior under actual production topology. The ~4-minute real SerpApi latency (Section 20) is
worth a few more real staging samples before any scheduling change is considered.
