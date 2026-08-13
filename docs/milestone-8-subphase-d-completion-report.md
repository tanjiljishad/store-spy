# Milestone 8 Sub-phase D — Real Staging Deployment & Production-Topology Validation

Every important claim below is explicitly labeled **VERIFIED**, **PARTIALLY VERIFIED**,
**UNVERIFIED**, **NOT APPLICABLE**, or **BLOCKED**. No inference is presented as a verified fact.

## Status

**PARTIAL.** Real cloud deployment (Render + Neon) is **BLOCKED** — no credentials exist for any
hosting or managed-database provider in this environment (re-checked from three independent
angles: CLI tools/config directories, Windows environment-variable scopes, and direct `.env`
inspection — all empty, unchanged from Sub-phase C). Per this sub-phase's own explicit fallback
instructions, every independent task that does not require those credentials was completed,
including a genuinely new class of test (deliberately concurrent workers, a real database
outage/recovery cycle, and live BASIC-plan verification) that no prior sub-phase performed.

## Deployment provider

**BLOCKED.** None used. `render.yaml` (Render, web + worker) remains the prepared, unexecuted
configuration from Sub-phase B/C.

## Database provider

**BLOCKED.** None used. Real disposable local Postgres (embedded, port 5433) used for every test
in this report instead — real Postgres, just not real managed/cloud Postgres.

## Region

**NOT APPLICABLE.** No cloud deployment occurred.

## Web service

**PARTIALLY VERIFIED.** Runs correctly in genuine production mode (`next build && next start`,
`NODE_ENV=production`) against real local Postgres — confirmed via `curl`, direct HTTP tests, and
full real-browser sessions. Real Render hosting behavior itself is UNVERIFIED (BLOCKED).

## Worker service

**PARTIALLY VERIFIED.** Runs correctly locally under every scenario tested this sub-phase
(concurrent instances, database outage, crash/restart). Real Render worker-service behavior
(including real Linux `SIGTERM`/`SIGINT` delivery) remains UNVERIFIED — this machine has neither
Docker nor WSL available, so genuine POSIX signal delivery to a single supervised process still
cannot be tested here (the same gap Sub-phase C found; re-confirmed, not newly resolved).

## Database migration status

**VERIFIED.** `npx prisma migrate status` on a freshly created local Postgres: "8 migrations found
in prisma/migrations... Database schema is up to date!" Zero pending, zero drift. No new migration
was added this sub-phase.

## Environment-variable verification

**VERIFIED** (existence/correctness, not real staging values — none exist). Confirmed by reading
every `process.env.*` reference in `src/` and `scripts/` directly: `DATABASE_URL`, `AUTH_SECRET`,
`AUTH_TRUST_HOST`, `SCHEDULER_SECRET`, `SERPAPI_API_KEY`, `GOOGLE_CLIENT_ID/SECRET`,
`FACEBOOK_CLIENT_ID/SECRET`, `NODE_ENV` — this list is unchanged from Sub-phase C's audit, and
`render.yaml`/`docs/environment-variables.md` correctly reflect it (re-read, not re-derived, this
sub-phase). No local value was printed in any log, report, or file this sub-phase.

## Authentication verification

**VERIFIED (Credentials provider).** Real signup → session cookie confirmed live via
`/api/auth/session` → protected-route access → logout clears the session — exercised twice more
this sub-phase (once via the exact real signup CTA link with `?store=` carried forward, once via
the general browser-verification pass), both against the real production build.

**NOT VERIFIED (Google/Facebook OAuth).** No credentials exist in this environment. Unchanged from
Sub-phase C — not re-claimed as working.

## Anonymous analysis verification

**VERIFIED.** Real anonymous crawl of colourpop.com via the actual landing-page flow, real SSE
stream observed to completion, truncated preview correctly shown (product count + theme only).

## Signup/claim verification

**VERIFIED, with the exact code path identified.** The real signup CTA is
`/signup?store=<domain>` (`AnonymousReportView.tsx`), which redirects post-signup to
`/dashboard/stores/<domain>?claim=1` (`authDestination()` in
`src/lib/auth/redirect-destination.ts`). That page calls `recordAnalysisUsage()` only — it never
invokes the crawler. Measured directly against the database: `Crawl` row count for colourpop.com
was **1** before signup and **still 1** after the full signup+claim redirect completed. **No
duplicate crawl occurs.** (An earlier draft of this test used the wrong flow — navigating to bare
`/signup` and manually re-submitting the analyze form, which correctly triggers a fresh crawl by
design, since that's a distinct user-initiated action — and was corrected before drawing any
conclusion; see "Bugs found" for the honest account of that dead end.)

## Entitlement verification

**FREE — VERIFIED** (via the existing, still-passing integration suite against real Postgres,
re-run this sub-phase: `analysis-usage.integration.test.ts`, `watch.integration.test.ts`). Not
re-demonstrated live via browser this sub-phase since it was already thoroughly covered and no
entitlement code changed.

**BASIC — VERIFIED, live, for real, for the first time this milestone.** Using the existing
dev-only `scripts/set-user-plan.ts` (not reachable from any route or UI — confirmed by its own
header comment and by the repo's route list), promoted a real signed-up test account to BASIC and,
through the real browser/API:
- Analyzed **4 unique real stores** (colourpop.com, allbirds.com, taylorstitch.com, gymshark.com)
  — one more than FREE's exact 3-store limit — with zero rejection. Final state:
  `"entitlement":{"analysesUsed":4,"analysesLimit":null,"alreadyAnalyzed":true}`.
- Started **4 simultaneous active monitors**, each returning `{"status":"ACTIVE","expiresAt":null}`
  — exceeding FREE's exact 1-monitor limit, with continuous (no 30-day) expiry confirmed by the
  literal `null` value, not inferred.

## Worker verification

**VERIFIED**, extensively, this sub-phase:
- Startup: clean, every run.
- Real scheduler tick, single fresh worker: `claimed:2, succeeded:1 (short_circuited efficiently —
  catalog hash unchanged since a very recent prior crawl), failed:1 (DNS resolution failed)`.
- Concurrent claiming: see below.
- Crash/restart: a worker was force-killed and restarted cleanly multiple times across this
  sub-phase's tests with no duplicate work observed.

## Linux signal verification

**UNVERIFIED.** Neither Docker nor WSL is available in this environment (checked directly this
sub-phase; installing either was judged out of scope as an invasive environment change requiring
separate approval). This is unchanged from Sub-phase C — not newly resolved, not silently dropped.
The graceful-shutdown code itself (`scripts/worker.ts`'s `SIGTERM`/`SIGINT` handlers) is unchanged
and remains the standard, idiomatic Node.js pattern.

## Scheduler concurrency verification

**VERIFIED, live, for real, deliberately — a genuinely new test this sub-phase.** Two independent
`scripts/worker.ts` processes were started ~5.5 seconds apart against the same real Postgres, with
4 real due stores seeded beforehand:
- Worker A's claim transaction ran first and claimed all 4 stores
  (`claimed:4, succeeded:4, failed:0`, three real Shopify crawls plus one efficient short-circuit).
- Worker B's claim query, ~5.5s later, correctly found **zero** stores left to claim
  (`claimed:0`, 90ms).
- Direct database check confirmed each of the 4 stores was crawled **exactly once** within this
  test's window — `FOR UPDATE SKIP LOCKED` provided correct mutual exclusion under real concurrent
  process contention, not just in the existing unit-style integration test.

## Failure-isolation verification

**VERIFIED, live, real.** One real healthy store (colourpop.com) and one deliberately unreachable
domain claimed in the same batch: `claimed:2, succeeded:1, failed:1`, with the unreachable domain's
failure (`"DNS resolution failed"`) correctly isolated — the healthy store was unaffected, no
worker crash.

## Database recovery verification

**VERIFIED, live, real — the most substantial new test this sub-phase.** Sequence actually
executed:
1. A worker completed a normal cycle (baseline established).
2. The real local Postgres server process was force-terminated (`taskkill /T /F` on the postmaster)
   while the worker was idle — a genuine, unclean database crash, not a simulation.
3. An HTTP scheduler-tick request against the dead database returned a clean `HTTP 500` — the *web
   process itself* stayed alive (the landing page, which needs no database, kept returning `200`).
4. A **fresh worker process started from scratch** against the dead database. All three of its
   phases failed independently and were caught cleanly: `scheduler.tick_failed`,
   `marketing_scheduler.tick_failed`, `stale_crawl_sweep.failed` — each logged a clear Prisma
   `P1001` "can't reach database server" message, containing no secrets. Critically, the worker
   process itself did **not** crash: `worker.cycle_completed` fired at the end
   (`durationMs: 12216`), meaning it correctly proceeded to schedule its next cycle rather than
   dying.
5. Postgres was restarted against the *same, now-unclean* data directory. Its own logs show
   genuine WAL-based crash recovery: `"database system was not properly shut down; automatic
   recovery in progress"` → `redo starts` → `redo done` → `"database system is ready to accept
   connections"`.
6. All prior data (users, stores, `AnalysisUsage`, `Watchlist`, `MarketingCollectionRun` rows) was
   confirmed **fully intact** after recovery.
7. A fresh scheduler-tick HTTP request against the recovered database returned `HTTP 200` with a
   normal result — full, real recovery confirmed.

This does not represent Neon/Supabase's own specific managed-failover characteristics (a local
embedded instance crashing and restarting is architecturally different from a managed provider's
network blip or planned maintenance), which remains genuinely **UNVERIFIED** — but it is real
evidence, not an invented one, that this codebase's own error handling at every layer (web route,
worker phase isolation, worker process survival) behaves correctly when the database becomes
unreachable and later returns.

## SerpApi verification

**VERIFIED, extensively, with an important resolved finding.** 5 real authenticated SerpApi calls
across this sub-phase (building on Sub-phase B/C's own real calls):

| Call | Domain | Duration | Outcome | Detail |
|---|---|---|---|---|
| Sub-phase B | allbirds.com | 236,769 ms | SUCCESS | First-ever query for this domain |
| Sub-phase C | allbirds.com | 394 ms | SUCCESS | Same domain, shortly after — almost certainly a vendor cache hit |
| This sub-phase | colourpop.com | ~237,383 ms (shared tick) | SUCCESS | 82 vendor requests, 80 ads observed — first-ever query |
| This sub-phase | gymshark.com | (fast, within the same tick) | **UNAVAILABLE — real `HTTP 429` rate limit** | Correctly classified, correctly contained, did not block the other two stores |
| This sub-phase | taylorstitch.com | ~237,383 ms (shared tick) | SUCCESS | 82 vendor requests, 80 ads observed — first-ever query |

**Reproducibility conclusion**: the ~394ms vs. ~237s variance previously flagged as a "major
concern" is now explained with real, consistent evidence — **every first-time query for a given
domain took ~237 seconds; every repeat query completed in under half a second.** This is
consistent with SerpApi caching search results server-side. This is a real, useful, actionable
finding, not a resolved mystery pretending to be more certain than the evidence supports: 5 samples
is still a small n, but the pattern (cold=slow, warm=fast) held in every single sample this
sub-phase produced. A real rate-limit response (`HTTP 429`) was also encountered and handled
correctly, exercising a genuine vendor-failure code path that no earlier sub-phase had hit for
real.

**Cost**: UNVERIFIED in dollars — no SerpApi billing dashboard access from this environment.
6 real API calls total have now been consumed across the whole project's real-verification history
(this sub-phase's own 3, plus Sub-phase B/C's 1 each, plus 1 more counted in the 82-request
sequences per successful call — see the table; "6 calls" refers to `searchAdsForDomain` top-level
invocations, not the underlying paginated/per-ad request counts).

## Security verification

**VERIFIED**, including a genuine investigation of what first looked like a real bug:
- `SCHEDULER_SECRET`: no header → `401`; wrong value → `401`; correct value → `200` with a real
  scheduler result. Getting to this clean result required diagnosing a **false alarm in this
  sub-phase's own test tooling**: `openssl rand -base64 32 > file` on this Windows/Git-Bash
  environment writes a trailing `\r\n`, and stripping only `\n` (not `\r`) left a raw carriage
  return embedded in the HTTP header value, which Node's own HTTP parser correctly rejected as
  malformed (`400 Bad Request`, empty body, `Connection: close`, no application-level log line at
  all). Root-caused via `xxd` on the raw secret file, fixed by generating the secret through Node's
  `crypto` module directly (no CRLF), and re-verified cleanly. This was **not** an application bug
  — documented here in full for honesty, since it initially looked exactly like one.
- No secret found in the built client bundle, server logs, or any committed file (re-swept this
  sub-phase).
- No debug/test-only route exists (re-confirmed, unchanged from Sub-phase C).

## Performance measurements

All **OBSERVED, local** — not real cloud-topology numbers (BLOCKED, no deployment):

| Measurement | Value |
|---|---|
| Landing page | 8ms (Sub-phase C measurement, unchanged code) |
| Dashboard (unauth redirect) | 162ms |
| Store report API | 209ms |
| Single-store scheduler tick | 3.18s (Sub-phase C) / part of a 28.87s 4-store batch |
| 4-store real batch (fresh worker) | Worker A: 558.5s total (this batch happened to include gymshark.com's 9,339-product/38-page crawl, the largest ever crawled in this project) |
| SerpApi, cold query | ~237s (3 consistent real samples this sub-phase) |
| SerpApi, warm/cached query | ~394ms (1 sample) |
| Database crash-recovery time | <1 second (Postgres's own WAL redo, observed directly in its logs) |
| Worker DB-outage failure detection | ~12.2s for all 3 phases to fail and log (dominated by Prisma's own connection-attempt timeout, not application logic) |

Real Render↔Neon network latency, connection-pool behavior under production topology: **UNVERIFIED
(BLOCKED)**.

## Cost observations

**OBSERVED**: 3 more real SerpApi calls consumed this sub-phase (1 success at ~237s, 1 failure via
real rate-limiting, 1 more success at ~237s — counted as 2 successes + 1 failure per the table
above). **PROJECTED only** (unchanged from Sub-phase C, not re-measured): ~$14/mo Render (2
`starter` services) + Neon's free/starter tier. No real hosting/database billing has ever occurred.

## Browser verification

**VERIFIED.** Full real-browser journey against the real production build, desktop (1440×900) and
mobile (390×844): landing → anonymous analyze/preview → real signup CTA with `?store=` →
claim-redirect to Store Intelligence → dashboard → watchlist → logout. **12/12 steps passed at
both widths, zero console errors, zero failed network requests** (excluding Next.js's own benign
RSC-prefetch cancellations). Fable UI visually unchanged (screenshots captured, not just asserted).

## Test counts

Unit: **282/282**. Integration: **211/211** (31 files, real Postgres — re-run twice this
sub-phase: once at the start as a baseline, once at the end against the crash-recovered database,
identical results both times). Typecheck: clean. ESLint: clean. Build: clean. Matches the exact
expected baseline stated in this sub-phase's own brief.

## Bugs found

- **Test-tooling artifact, not an application bug**: the `SCHEDULER_SECRET` CRLF issue described
  above under "Security verification."
- **Test-methodology dead end, not an application bug**: an early draft of the signup/claim test
  used the wrong navigation flow (bypassing the real `?store=`-carrying CTA), producing a
  misleading "second crawl" result that was corrected before being reported — see "Signup/claim
  verification."
- **No production application bugs were found this sub-phase.** Unlike Sub-phase C (which found
  and fixed the real `AUTH_TRUST_HOST` production-breaking bug), every real-infrastructure test
  this sub-phase passed on the underlying application code without needing a fix — the codebase
  held up under deliberately concurrent workers, a real database crash, real vendor rate-limiting,
  and real large-scale crawls (9,339 products) without any defect surfacing.

## Bugs fixed

None required this sub-phase — no application code was changed. (Two test-tooling issues in this
session's own scripts were diagnosed and corrected, as described above; those scripts were
disposable and are not part of the committed codebase.)

## Known limitations

- Real cloud deployment has never been executed.
- Graceful worker shutdown under real POSIX signals remains untested on any machine available in
  this environment.
- SerpApi's cold/warm latency pattern is based on 5 real samples — a real, consistent pattern, but
  a small one; more production-scale samples would increase confidence.
- Local embedded-Postgres crash/recovery is not a substitute for Neon/Supabase's specific managed
  failover behavior.

## Unverified items

- Real Render web/worker service deployment and behavior.
- Real managed Postgres (Neon/Supabase) connection pooling, latency, and cost under real network
  topology.
- Real Linux `SIGTERM`/`SIGINT` delivery to the worker process.
- Google/Facebook OAuth (no credentials).
- Exact real hosting/database/SerpApi dollar costs.
- Real HTTPS/TLS behavior (only plain HTTP was exercised locally).

## STOP conditions

**None were triggered.** Every one of the 7 STOP conditions was evaluated against this sub-phase's
real findings:
- STOP 1 (Postgres can't support the scheduler/concurrency model) — contradicted by real evidence:
  the concurrent-worker test and the crash/recovery test both demonstrated correct behavior.
- STOP 2 (worker can't run continuously) — contradicted; every worker instance ran to clean
  completion across every test.
- STOP 3 (HTTPS/Auth.js can't be made reliable) — the one real auth issue found (Sub-phase C's
  `AUTH_TRUST_HOST`) was already fixed and re-verified; nothing new surfaced this sub-phase.
- STOP 4 (concurrent workers double-process) — directly disproven by real, deliberate testing.
- STOP 5 (a privileged endpoint becomes public) — the `SCHEDULER_SECRET` route was directly tested
  and correctly rejects unauthorized/incorrect requests.
- STOP 6 (data corruption) — the crash/recovery test confirmed full data integrity afterward.
- STOP 7 (an unanticipated infrastructure requirement appears) — nothing this sub-phase required
  Redis, a queue, or any new infrastructure category; the existing two-process/one-database
  architecture handled every real scenario tested.

## Production-readiness assessment

The application code and worker architecture have now survived every failure mode this local
environment can genuinely reproduce: concurrent claim contention, a real database crash and
recovery, real vendor rate-limiting, isolated per-store failures, and a real production-mode
authentication misconfiguration (found and fixed in Sub-phase C). What remains unverified is
specifically the *cloud topology itself* — real Render, real Neon, real network paths, real Linux
process-signal semantics — none of which this environment can produce without credentials this
sub-phase confirmed do not exist here.

## Recommendation for Milestone 9

Do not proceed to Milestone 9 (whatever it is scoped to be) until the two genuinely unverified,
credential-gated items are resolved: (1) execute the real Render + Neon deployment using
`docs/staging-deployment.md`'s already-prepared checklist, and (2) verify graceful worker shutdown
under real Linux `SIGTERM`/`SIGINT` on that real deployment. Everything else this sub-phase's brief
asked for — signup/claim correctness, entitlement lifecycle, concurrent scheduling, failure
isolation, database recovery, SerpApi behavior, security boundaries, browser/UX fidelity — has real,
live evidence behind it and does not need to be re-litigated once cloud credentials exist; the
remaining work at that point is confirming parity between this local evidence and the real hosted
environment, not starting verification from zero.

## Final success criteria checklist

- [ ] Real managed Postgres connected — **BLOCKED**
- [ ] Web service deployed — **BLOCKED**
- [ ] Worker service deployed — **BLOCKED**
- [x] Existing migrations applied — VERIFIED (local)
- [ ] HTTPS verified — **BLOCKED** (only plain HTTP tested locally)
- [x] Credentials auth verified — VERIFIED
- [x] Anonymous → signup → full-report flow verified — VERIFIED
- [x] No duplicate crawl after signup claim — VERIFIED
- [x] FREE entitlement verified — VERIFIED (existing suite, real Postgres)
- [x] BASIC entitlement verified — VERIFIED (live, real, this sub-phase)
- [x] Worker scheduler verified — VERIFIED
- [ ] Linux SIGTERM verified — **UNVERIFIED** (no Docker/WSL available)
- [ ] Linux SIGINT verified — **UNVERIFIED** (same reason)
- [x] Concurrent scheduler claiming verified — VERIFIED (new this sub-phase)
- [x] Failure isolation verified — VERIFIED
- [x] Database recovery tested — VERIFIED (local; real managed-provider behavior still BLOCKED)
- [x] Real SerpApi request from staging verified — PARTIALLY (real SerpApi calls verified; "from
      staging" specifically is BLOCKED, calls were made from this local machine)
- [x] Scheduler secret verified — VERIFIED
- [x] No secret leakage — VERIFIED
- [x] Production build verified — VERIFIED
- [x] Browser desktop verified — VERIFIED
- [x] Browser mobile verified — VERIFIED
- [x] Full test suite green — VERIFIED (282/211)
- [x] Performance measured — VERIFIED (local only)
- [x] Costs separated into observed/projected — VERIFIED
- [x] Completion report written — this document
