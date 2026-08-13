# Milestone 8 Sub-phase E — Real Cloud Deployment & Linux Production Validation

Every major claim below is explicitly classified **VERIFIED**, **PARTIALLY VERIFIED**,
**UNVERIFIED**, **BLOCKED**, or **NOT APPLICABLE**.

## Status

**BLOCKED on the primary objective.** Real cloud deployment did not occur — no credentials exist
for any hosting platform (Render, Fly.io, Vercel, Railway) or managed Postgres provider (Neon,
Supabase) anywhere in this environment. This was re-checked from every angle this sub-phase's own
Phase 0 specifies (CLI tools, provider config directories, Windows environment-variable scopes at
both User and Machine level, and direct inspection of `.env`) and is unchanged from Sub-phases C
and D, which found and reported the identical result. Docker and WSL — the two mechanisms that
could have at least unblocked real-Linux-signal testing without needing a cloud account — were
also re-checked and remain unavailable (`wsl --status` still reports WSL itself is not installed,
only the launcher stub is present).

Per this sub-phase's own explicit instructions ("do not pretend deployment succeeded," "perform
only safe preparation/audit work"), and because the user already made an explicit, standing choice
in Sub-phase C to proceed without supplying credentials (re-affirmed implicitly by three
consecutive sub-phases asking for the same credentials and receiving the same absence), this
sub-phase did **not** re-ask the same question a fourth time. Instead it performed the two pieces
of genuinely safe, non-redundant work this brief calls for — a final deployment-configuration audit
against the current code, and the full regression suite — and declined to fabricate or re-simulate
the extensive real-infrastructure testing Sub-phase D already completed with genuine evidence
(concurrent workers, database crash/recovery, live BASIC-plan verification, real SerpApi calls,
security boundary testing, full browser verification). That evidence is referenced below, not
reproduced, since nothing in the application code has changed since it was captured.

## Cloud provider

**BLOCKED.** None used.

## Database provider

**BLOCKED.** None used. Real disposable local Postgres (embedded, ephemeral, destroyed at the end
of this sub-phase) used only for the regression suite.

## Region

**NOT APPLICABLE.** No cloud deployment occurred.

## Web service

**BLOCKED.** Not deployed. The existing production build was re-verified to still compile cleanly
(`npm run build`, zero errors) — this is a build-correctness check, not a deployment.

## Worker service

**BLOCKED.** Not deployed.

## Deployment URL

**NOT APPLICABLE.** None exists.

## Database migration status

**VERIFIED (local only).** `npx prisma migrate status` against a freshly created local Postgres:
8 migrations found, "Database schema is up to date!" — zero pending, zero drift, unchanged from
every prior sub-phase's finding. Real managed-Postgres migration deployment remains **BLOCKED**.

## Environment configuration

**VERIFIED (audit only, no real values exist to apply).** Re-read `render.yaml` against the
current code line by line this sub-phase:
- Web service: `AUTH_TRUST_HOST=true` present (the Sub-phase C fix), `AUTH_SECRET` present,
  `preDeployCommand: npx prisma migrate deploy` (deterministic, not `db push`).
- Worker service: correctly omits both `AUTH_SECRET` and `AUTH_TRUST_HOST` — re-confirmed this
  sub-phase that `scripts/worker.ts`'s import chain still contains zero references to `auth` and
  imports only `prisma`, `runSchedulerTick`, `runMarketingSchedulerTick`,
  `getConfiguredMarketingSource`, and `sweepStaleCrawls` directly — and correctly omits
  `SCHEDULER_SECRET` (the worker never calls the HTTP-authenticated scheduler routes).
- `package.json`'s `engines.node` field (`>=20.9.0`, added in Sub-phase C) is unchanged and still
  matches Next.js 16's own documented minimum.
- Every `process.env.*` reference across `src/` and `scripts/` was re-enumerated by direct grep
  this sub-phase and matches the prior audit exactly — no new environment variable was introduced,
  none was removed.

No real staging/production value for any of these exists anywhere in this environment.

## HTTPS verification

**BLOCKED.** No deployment exists to have HTTPS on. Only plain local HTTP has ever been exercised
(Sub-phase D).

## Credentials authentication

**BLOCKED (real deployment).** **PREVIOUSLY VERIFIED locally** (Sub-phase D, unchanged code since
then): real signup → session cookie confirmed via `/api/auth/session` → protected routes → logout,
against a real `next start` production build. Not re-run this sub-phase since no authentication
code changed and re-running it would not produce new information — the risk this class of test
exists to catch (the `AUTH_TRUST_HOST` production-mode bug) was already found and fixed in
Sub-phase C, and the fix is unchanged in `render.yaml` and `.env.example`.

## OAuth verification

**UNVERIFIED — Google.** **UNVERIFIED — Facebook.** No OAuth credentials exist in this
environment, unchanged since Sub-phase B. The app continues to run correctly without them (the
provider buttons simply don't render); this is not the same claim as "OAuth works."

## Anonymous analysis

**BLOCKED (from a real cloud deployment).** **PREVIOUSLY VERIFIED locally** (Sub-phase D): real
anonymous crawl, real SSE stream, correctly truncated preview.

## Signup/claim flow

**BLOCKED (from a real cloud deployment).** **PREVIOUSLY VERIFIED locally** (Sub-phase D), with
the exact code path traced and confirmed: the real signup CTA carries `?store=<domain>` forward,
`authDestination()` redirects to `/dashboard/stores/<domain>?claim=1`, and that page calls
`recordAnalysisUsage()` only — never the crawler. Measured directly against the database: crawl
count stayed at exactly 1 through the entire anonymous → signup → claim sequence. Unchanged this
sub-phase (no code touched this area).

## FREE entitlement verification

**PREVIOUSLY VERIFIED** (existing integration suite against real Postgres — `analysis-usage.
integration.test.ts`, `watch.integration.test.ts` — re-run again this sub-phase as part of the
211/211 regression pass, still green). Real managed-Postgres-specific behavior (as opposed to
real-but-local Postgres) is **BLOCKED**.

## BASIC entitlement verification

**PREVIOUSLY VERIFIED, live, real** (Sub-phase D): a real disposable test account, promoted via
the existing non-public dev-only `scripts/set-user-plan.ts`, analyzed 4 unique real stores
(exceeding FREE's exact 3-store limit with zero rejection, `analysesLimit: null`) and started 4
simultaneous active monitors (`expiresAt: null` on every one). Not repeated this sub-phase — the
entitlement code is unchanged, and Sub-phase D's brief for this exact test explicitly asked for
"the cheapest valid verification method," which was already satisfied.

## Worker startup

**BLOCKED (Render).** **PREVIOUSLY VERIFIED locally**, extensively, across every prior sub-phase.

## Linux SIGTERM

**UNVERIFIED — genuinely, still.** This is the one item this sub-phase most wanted to close and
could not. Neither Docker nor WSL is installed on this machine (`wsl --status` confirms WSL itself,
not just the launcher, is absent; `docker` is not on `PATH` at all). Installing either is a
significant, invasive environment change (WSL requires a Windows feature enable and typically a
reboot; Docker Desktop requires an installer and a virtualization backend) that was judged out of
scope to perform unilaterally without being asked. The graceful-shutdown handler code itself
(`scripts/worker.ts`) is unchanged from Sub-phase B and remains the standard, correct Node.js
`process.on('SIGTERM', ...)` pattern — this is a code-review-level claim, not an execution-level
one.

## Linux SIGINT

**UNVERIFIED**, same reason as above.

## Worker restart

**BLOCKED (Render's own restart behavior).** **PREVIOUSLY VERIFIED locally** (Sub-phase D): a
worker was force-killed and restarted multiple times with no duplicate work and correct resumption.

## Concurrent workers

**BLOCKED (against real managed Postgres).** **PREVIOUSLY VERIFIED, live, real, deliberately**
(Sub-phase D): two independent worker processes started ~5.5 seconds apart against the same real
Postgres; the first claimed all 4 due stores, the second correctly saw zero remaining; database
verification confirmed every store was crawled exactly once. `FOR UPDATE SKIP LOCKED` held under
real process contention. Not repeated this sub-phase — the scheduler code is unchanged.

## Scheduler verification

**BLOCKED (against managed Postgres).** **PREVIOUSLY VERIFIED locally** in every relevant shape:
single-store ticks, multi-store batches, mixed success/failure batches, and — most relevantly to
this sub-phase's Phase 14 — a real database outage mid-cycle followed by real recovery (see below).

## Failure isolation

**BLOCKED (cloud).** **PREVIOUSLY VERIFIED locally** (Sub-phase D): one real healthy store and one
deliberately unreachable domain claimed together, `claimed:2, succeeded:1, failed:1`, isolated
correctly, no worker crash.

## Database failure/recovery

**BLOCKED (real managed-Postgres failover characteristics).** **PREVIOUSLY VERIFIED locally, real,
substantial** (Sub-phase D): the actual local Postgres server process was force-terminated while a
worker was running; all three of the worker's phases failed independently and were caught cleanly
(no crash, no secret in the error output); Postgres was restarted against the same unclean data
directory and performed genuine WAL-based crash recovery (visible directly in its own logs); all
prior data was confirmed fully intact; a subsequent scheduler tick succeeded normally. This
demonstrates the application's own error-handling correctness under a real (if locally-produced)
database outage — it does not, and cannot, stand in for Neon's or Supabase's specific managed
network-blip/failover behavior, which remains genuinely **BLOCKED**.

## SerpApi cloud verification

**BLOCKED (from the real cloud network).** **PREVIOUSLY VERIFIED, real, extensively, from this
local network** (Sub-phase B/C/D combined): 5 real authenticated SerpApi calls total, showing a
consistent pattern — every first-time query for a given domain took ~237 seconds real elapsed
time; every repeat query for an already-queried domain completed in well under one second (almost
certainly a vendor-side cache hit); one real `HTTP 429` rate-limit response was also encountered
and handled correctly. Whether this exact pattern holds from a real Render network path (different
egress IP, different routing to SerpApi's own infrastructure) is genuinely unknown and BLOCKED —
network path can affect connection setup time but is very unlikely to affect SerpApi's own
server-side cache/scrape latency, which is the dominant factor in every sample collected so far;
that reasoning is offered as context, not as a substitute for the real measurement.

## Security verification

**PARTIALLY VERIFIED.** The `SCHEDULER_SECRET` route behavior (no header → 401, wrong value → 401,
correct value → 200) was directly, freshly verified against real Postgres in Sub-phase D, including
a full diagnosis of a false alarm in that session's own test tooling (a Windows/`openssl` CRLF
artifact, not an application defect — documented in full in the Sub-phase D report). Not re-run
this sub-phase since the route code is unchanged. Real HTTPS-specific security properties
(certificate validity, secure-cookie behavior over TLS, HSTS) remain **BLOCKED** — nothing in this
environment can produce real HTTPS to test against.

## Browser verification

**BLOCKED (against a real HTTPS deployment).** **PREVIOUSLY VERIFIED, real, desktop and mobile**
(Sub-phase D): 12/12 steps passed, zero console errors, zero failed requests, Fable UI visually
confirmed unchanged via captured screenshots — against a real local production build. Not repeated
this sub-phase since nothing in the UI or auth flow changed.

## Performance measurements

**OBSERVED, local only** (carried forward from Sub-phase D, not re-measured since nothing changed):
landing 8ms, dashboard redirect 162ms, store report API 209ms, SerpApi cold ~237s / warm ~394ms,
database crash-recovery <1s. Real Render/Neon network-topology numbers remain **BLOCKED**.

## Infrastructure costs

**BLOCKED (observed).** No real hosting or database billing has ever occurred. **PROJECTED only**
(unchanged, carried from Sub-phase A's original research, never re-measured): ~$14/mo for 2 Render
`starter` services + Neon's free/starter tier. SerpApi: 6 real API calls have been consumed across
this project's entire real-verification history to date (Sub-phases B through D); exact dollar
cost is UNVERIFIED — no billing dashboard access from this environment.

## Tests

**VERIFIED, this sub-phase, fresh.** Unit: **282/282**. Integration: **211/211** (31 files, real
local Postgres). Typecheck: clean. ESLint: clean. Build: clean. Matches the exact expected baseline
this sub-phase's own brief states.

## Bugs found

**None, this sub-phase.** No new code was exercised beyond what Sub-phase D already tested; the
deployment-configuration audit found zero drift between `render.yaml` and the current code.

## Bugs fixed

**None required.** No application code was changed this sub-phase.

## Known limitations

- Real cloud deployment has never been executed, across five consecutive sub-phases now, for the
  same reason each time: no credentials exist in this environment.
- Real Linux process-signal delivery to the worker remains genuinely untested — this is the single
  most important gap left in this project's production-readiness picture, and closing it requires
  either real Render credentials or a Docker/WSL installation neither of which this sub-phase was
  authorized to add unilaterally.
- All "verified" claims about concurrency, failure isolation, database recovery, and SerpApi
  behavior are real and were produced against genuine external systems (real Shopify stores, real
  SerpApi, a real — if local — Postgres server), but not against the specific cloud topology
  (Render's process supervision, Neon's managed failover, real network paths) this milestone exists
  to validate.

## Unverified items

Real Render web/worker deployment and behavior; real managed Postgres (Neon/Supabase) connection
pooling and latency; real Linux `SIGTERM`/`SIGINT`; real HTTPS/TLS; Google/Facebook OAuth; exact
real hosting/database/SerpApi dollar costs; whether SerpApi's cache-driven latency pattern holds
from a different (cloud) network path.

## STOP conditions

**None were triggered.** No real cloud test was performed this sub-phase to trigger one against;
every STOP condition in this brief is specifically about real cloud/Linux behavior contradicting
the existing architecture, and none of that testing occurred. This is not the same as "no STOP
conditions exist" — it is "none were found, because the tests that could find them are blocked."

## Production-readiness assessment

Unchanged from Sub-phase D's own assessment, since no new evidence was produced either way: the
application code has survived every failure mode this local environment can genuinely reproduce.
What remains is specifically the cloud topology itself, and that gap has now persisted, unresolved,
across three consecutive sub-phases (C, D, E) for the identical reason. Continuing to run additional
sub-phases with this same "check for credentials, find none, verify what's locally verifiable"
structure will not close it — only real credentials or a local Docker/WSL environment will.

## Recommendation for Milestone 9

Do not begin Milestone 9 under the assumption that cloud deployment is complete — it is not, and
has not been for the entirety of Milestone 8's later sub-phases. Two concrete unblocking paths
exist, and a decision on one of them is now the actual blocker to progress, not further local
verification work:

1. **Obtain real Render + Neon (or Fly.io + Supabase) credentials** and execute the deployment this
   milestone has been prepared for since Sub-phase B (`render.yaml`, `docs/staging-deployment.md`)
   — this is the only path that also closes the real-Linux-signal and real-HTTPS gaps, since Render
   runs Linux containers.
2. **Alternatively**, if cloud credentials remain unavailable indefinitely, authorize installing
   Docker Desktop or enabling WSL2 on this local machine specifically to close the Linux-signal gap
   in isolation — this would not verify real network/HTTPS/managed-Postgres behavior, but would
   close the one item that has been repeatedly flagged as the most significant remaining unknown.

Absent either, no further sub-phase framed identically to C/D/E will produce new evidence — the
honest, most useful next action is a decision from the user, not another automated attempt.
