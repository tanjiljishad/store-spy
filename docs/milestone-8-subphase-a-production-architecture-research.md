# Milestone 8, Sub-phase A — Production Architecture & Infrastructure Research

**Status: research and architecture only.** No application code was changed, no dependency was added, no
schema migration was created, no infrastructure was deployed. Every claim below is checked against the
actual current source (read fresh this sub-phase) or an external source fetched via live web search this
sub-phase — never assumed from a prior milestone's report. Every recommendation is explicitly labeled
**FACT** (verified directly, either in this repo's source or via a live external source cited below),
**INFERENCE** (a conclusion this document draws from stated facts), or **ASSUMPTION** (a premise taken
as given because no better information exists, stated so a future session can revisit it).

---

## 1. Executive Summary

Bellwether's application code is materially more production-disciplined than its deployment story: the
crawler, scheduler, diff engine, and persistence layer already handle concurrency, idempotency, partial
failure, and UTC correctness the way a production system needs to — but **zero deployment
infrastructure exists today** (no Dockerfile, no `vercel.json`, no CI/CD config, no documented hosting
target). Development has only ever run against `next dev` and a disposable local/embedded Postgres.

The single most consequential finding: the existing scheduler (`runSchedulerTick`, `runMarketingSchedulerTick`)
processes a **batch of up to 10 stores sequentially inside one function call**, and a single large-catalog
crawl can legitimately take tens of seconds to low minutes (Section 6). Run behind a typical serverless
function timeout (Vercel Hobby: 60s; Pro default: 300s — Section 3/17, **FACT**, cited), a worst-case
tick (10 large stores) can exceed even a generous serverless budget. This does not require a rewrite —
the claim mechanism (`FOR UPDATE SKIP LOCKED` + a 10-minute claim-timeout that self-heals an interrupted
batch) already tolerates a tick being cut off mid-batch — but it does mean the **scheduler should not be
hosted as a tightly-time-limited serverless function** without either shrinking its batch size
dramatically or moving it to a host with generous/no execution-time limits.

**Recommended V1 architecture** (Section 27, detailed): a single Next.js application deployed to a
small-PaaS host that supports first-class, always-on background-worker/cron processes without a hard
execution-time ceiling (Render or Fly.io — both verified this sub-phase to support this natively, Section
3), running the *same codebase* in two process roles — `next start` for web, and a tiny long-running
Node entrypoint (calling the exact `runSchedulerTick`/`runMarketingSchedulerTick` functions that already
exist) for the worker — plus a managed Postgres provider with built-in connection pooling (Neon or
Supabase, both verified this sub-phase). **No queue, no Redis, no Kubernetes.** The existing
`FOR UPDATE SKIP LOCKED` claim mechanism is sufficient for V1 concurrency (Section 7) and the existing
bounded-query discipline (verified across three prior milestones) is sufficient for V1 database load
(Section 9).

No critical security problem was found. No schema change is required. No STOP condition (Section 26 of
the brief) was triggered.

---

## 2. Current Architecture

Verified by direct, fresh inspection this sub-phase.

**Application shape (FACT)**: one Next.js 16.3 App Router project (`package.json`), no monorepo, no
separate worker package. `next dev` / `next build` / `next start` are the only run scripts besides test
tooling. `next.config.ts` sets only `reactStrictMode: true` — no custom server, no `output: "standalone"`,
no rewrites/redirects/headers configuration, no Edge-runtime opt-in anywhere except the implicit default
(every route handler that touches Prisma or DNS explicitly sets `export const runtime = "nodejs"`,
confirmed by grep — the app already does not attempt to run any DB/crawl code on the Edge runtime).

**Process model today (FACT)**: there is exactly one deployable process type. `POST /api/analyze` (the
manual analyze flow) and the two scheduler-tick routes (`POST /api/internal/scheduler/tick`,
`POST /api/internal/scheduler/marketing-tick`) all run *inside the same Next.js web process*, as ordinary
API route handlers. There is no separate worker binary, no message broker, no job table beyond `Crawl`/
`MarketingCollectionRun` themselves (which are data records, not a queue). Local/dev scheduling is a
plain script (`scripts/scheduler-tick.ts`, `scripts/marketing-scheduler-tick.ts`) meant to be invoked by
OS-level cron or manually; the code comments in both scripts explicitly say the HTTP routes are "for
production (e.g. Vercel Cron)" — i.e., **the codebase's own authors already anticipated a cron-triggered-
HTTP-endpoint deployment model**, though nothing was ever built or configured beyond the route itself
(INFERENCE from the comment; the actual hosting decision was never made).

**Scheduler mechanics (FACT, Section 6/7 detail)**: `claimDueStores()`/`claimDueStoresForMarketing()`
both use a single `prisma.$transaction` running a raw `SELECT ... FOR UPDATE SKIP LOCKED LIMIT
<batchSize>`, then immediately push the claimed rows' `nextCrawlAt`/`nextMarketingCollectionAt` forward
by a fixed 10-minute `CLAIM_TIMEOUT_MS` before the transaction commits. This is the entire concurrency
mechanism — no queue, no distributed lock service. Two scheduler processes (or two overlapping ticks)
racing the same claim query can never claim the same store, verified by an existing integration test
(`scheduler.integration.test.ts`, "two ticks racing the SAME due-store pool never both collect the same
store"). Batch processing within one tick is sequential (a deliberate choice, per the code's own
comment: "one claimed batch's crawls share this tick's time/resource budget rather than competing for
it"), and one store's unexpected exception is caught per-store and does not abort the rest of the batch.

**Database (FACT)**: `src/lib/db/prisma.ts` is a bare `PrismaClient` singleton cached on `globalThis` in
non-production, with **no explicit connection-pool size configuration** anywhere in the codebase (no
`connection_limit` query-string parameter on `DATABASE_URL`, no PgBouncer, no pooler). `diff/persist.ts`
uses bulk `INSERT ... ON CONFLICT` raw SQL (never a per-row loop) inside one bounded transaction
(`timeout: 10_000, maxWait: 5_000`) per crawl — already production-shaped, not a prototype pattern.
Every raw-SQL timestamp write/comparison in the codebase explicitly casts `AT TIME ZONE 'UTC'` — a
discipline documented in `AGENTS.md` and enforced by dedicated non-UTC-session regression tests
(`timezone-safety.integration.test.ts` in both `monitoring/` and `marketing/`), re-verified passing this
sub-phase (see Milestone 7 Sub-phase D's own test run).

**Security (FACT)**: SSRF protection (`ssrf-guard.ts`) is allowlist-based (only `ipaddr.js`-classified
"unicast" addresses are fetchable), re-validated on every redirect hop (max 5), with a self-documented
residual gap (DNS-rebinding between check and connect — not closed, explicitly stated as a known,
accepted limitation, not an oversight). Rate limiting (`rate-limit.ts`) is in-memory and single-process,
with an explicit code comment: "NOT safe across multiple instances... a real multi-instance deployment
needs a shared store (Redis, etc.) instead." This is the one piece of already-shipped code that
directly constrains a scaling decision (Section 18/20).

**Auth (FACT)**: Auth.js v5 (`next-auth@5.0.0-beta.32`), **JWT session strategy** (not database
sessions) — chosen because the Credentials provider is documented as incompatible with Auth.js database
sessions. This means session validation on every request needs no database round-trip, which is
favorable for horizontal web scaling (INFERENCE) even though the `Session`/`Account` Prisma models
(the standard Auth.js adapter shape) still exist for OAuth account-linking bookkeeping.

**Vendors (FACT)**: exactly one external vendor is live-integrated today — SerpApi (Google Ads
Transparency Center), gated behind `SERPAPI_API_KEY` via `getConfiguredMarketingSource()`, which throws
loudly if unconfigured rather than silently no-op-ing. No OAuth app credentials are configured in any
committed file (`GOOGLE_CLIENT_ID`/`FACEBOOK_CLIENT_ID` are optional and the app runs fine without
them — `configuredProviders` gates the UI so a missing provider never renders a button that would 500).
No billing vendor, no email vendor, no error-tracking/observability vendor exists anywhere in the
dependency tree (`package.json` has zero such packages).

**Deployment artifacts (FACT)**: none exist. `Glob` for `Dockerfile*`/`vercel.json` returned no results.
No `.github/workflows` (unverified this sub-phase whether the directory exists at all — not found via
Glob, treated as absent). No `render.yaml`/`fly.toml`/`railway.json`. Every environment variable is
sourced from a plain `.env` file (correctly `.gitignore`d — verified: `.gitignore` line 2 is `.env`, and
`git log --all -- .env` returns zero history, confirming the real local SerpApi key currently in that
file has never been committed).

---

## 3. Current Production Readiness

| Concern | Status | Evidence |
|---|---|---|
| Crawler correctness under concurrency/partial failure | **Ready** | GUARD 1/2/3 (catalog-shrink abort, partial-crawl removal-skip, per-crawl event cap), all integration-tested against real Postgres across Milestones 5/7 |
| Scheduler concurrency safety | **Ready** | `FOR UPDATE SKIP LOCKED` + claim-timeout, integration-tested for concurrent-tick races |
| Persistence correctness | **Ready** | Bulk, transactional, idempotent (`dedupeKey` unique constraint + `skipDuplicates`), UTC-correct |
| SSRF protection | **Ready, with a documented residual gap** | Allowlist-based, redirect-re-validated; DNS-rebinding window not closed (explicitly documented, not hidden) |
| Rate limiting | **Not production-ready beyond one instance** | In-memory, single-process by the code's own admission |
| Deployment configuration | **Does not exist** | No Dockerfile/vercel.json/CI config found |
| Secrets management | **Local-file only** | No secrets-manager integration; `.env` correctly gitignored but nothing beyond that exists |
| Observability | **Does not exist** | No logging library, no error tracker, no metrics — `console.error`/`console.log` only |
| Email | **Does not exist** | No vendor, no code path |
| Billing | **Does not exist** | `PlanTier` enum has a `BUSINESS` placeholder (Section 23) but no subscription/webhook/payment code anywhere |

---

## 4. Deployment Options

Evaluated against Bellwether's actual current workload (Section 2), not a hypothetical large-scale one.

### Option A — Single Next.js application + managed PostgreSQL
Web requests and all background work (manual analyze, scheduled crawling, marketing collection) run in
the same process, scheduling driven by an external cron hitting the internal tick routes.
**Complexity**: lowest. **Cost**: lowest (one compute unit). **Crawler compatibility**: fine for manual
analyze (already a long-lived SSE response, Section 6); **risky** for the scheduler tick specifically if
the host enforces a tight execution-time ceiling (Section 1). **Operational burden**: minimal — one
thing to deploy, one thing to monitor. **Suitability for V1**: viable *only* on a host without an
aggressive function-duration limit, or with the scheduler batch size shrunk to fit comfortably inside
whatever limit exists.

### Option B — Next.js web + separate worker process + managed PostgreSQL
Same codebase, two deployed process roles: `next start` for web, a small long-running Node script for
the scheduler (calling `runSchedulerTick`/`runMarketingSchedulerTick` directly in a loop, no HTTP
indirection needed for the worker's own internal cron — though the existing HTTP routes can remain as a
manual-trigger/health-check surface). **Complexity**: low — one more deployed unit, zero new
libraries, zero new code paths (the functions already exist and are already tested standalone).
**Cost**: one more small always-on compute unit (Section 17). **Crawler/scheduler compatibility**:
excellent — no execution-time ceiling to worry about. **Concurrency**: unchanged from Option A (the
claim mechanism doesn't care how many processes call it, by design). **Suitability for V1**: this
sub-phase's recommendation (Section 27).

### Option C — Next.js + worker + Redis/queue + managed PostgreSQL
Adds a message broker (BullMQ/similar) between "store is due" and "a worker crawls it."
**Complexity**: materially higher — a new stateful service to run, monitor, and pay for; new failure
modes (queue backlog, poison messages, worker-vs-queue double-bookkeeping of "what's due"). **What it
would buy**: finer-grained retry/backoff policy, work distributed across many worker processes,
job-level observability out of the box. **What Bellwether does not have today that would justify it**:
multiple worker processes competing for the same claim query (there is currently exactly one worker
role, and `FOR UPDATE SKIP LOCKED` already makes N of them safe without a queue); a claimed need for
crawl-level retry finer than the existing 10-minute claim-timeout self-heal. **Suitability for V1**:
explicitly rejected by the brief's own "do not introduce Redis/queues... merely because they are common"
instruction, and no evidence in the current codebase or its actual load profile justifies the added
operational surface. Revisit only if Stage 3/4 scaling (Section 18) is actually reached.

### Option D — Serverless web + serverless/background workers + managed PostgreSQL
Vercel (or similar) for the web tier, Vercel Cron (or a serverless queue like Inngest/Trigger.dev) for
background work. **Complexity**: low to deploy, but the execution-time ceiling (Section 1/17, **FACT**:
Hobby 60s default, Pro 300s default, up to 800s with Fluid Compute in beta) is a real constraint the
scheduler's current batch-of-10-sequential shape does not comfortably fit without either a much smaller
batch size or a purpose-built background-job product (Vercel Workflows, mentioned in the same search
result as supporting "minutes to months" — **not independently verified this sub-phase beyond the
search snippet**, flagged as **ASSUMPTION-pending-verification** if this path is ever chosen).
**Connection pooling**: solved cleanly if paired with Neon or a similar pooled-Postgres provider
(Section 8). **Suitability for V1**: viable for the *web* tier specifically; viable for the *scheduler*
only with either a much smaller batch size (e.g., `batchSize: 1-2` invoked every 1-2 minutes instead of
`batchSize: 10` invoked every 10) or a background-job product this sub-phase did not deeply evaluate
(out of scope for "no new dependency").

### Option E — Containerized web + containerized worker + managed PostgreSQL
Docker images for both roles, deployed to any container host (Fly.io, Render, Railway, or a raw VM).
**Complexity**: slightly higher than Option B on a PaaS that already builds from source (Render/Railway
build directly from a repo without a Dockerfile being strictly required — **FACT**, per this sub-phase's
research), but affords the most host portability later. **Suitability for V1**: functionally equivalent
to Option B on the hosts this document actually recommends; a Dockerfile is not required to get Option
B's benefits on Render/Railway/Fly.io specifically, so this sub-phase treats E as "B, plus a Dockerfile,"
not a materially different architecture — worth doing eventually for host-portability, not blocking V1.

**Not evaluated as a serious V1 option**: Kubernetes, any multi-region active-active setup, any
self-managed Postgres cluster — all explicitly out of scope per the brief's "do not build infrastructure
for hypothetical millions of users" instruction, and nothing in Bellwether's current or foreseeable V1
load (Section 18) comes close to justifying the operational cost.

---

## 5. Recommended Deployment Architecture

(Elaborated fully in Section 27; summarized here since Section 4 already built the comparison.)

**Option B**, hosted on a PaaS with native, always-on background-worker support and no tight function-
duration ceiling — **Render** or **Fly.io** (Section 3, both verified this sub-phase to support this
without a queue or Redis). Paired with a managed Postgres provider offering built-in connection pooling
— **Neon** or **Supabase** (Section 3, both verified). No queue. No Redis. No container orchestrator.

---

## 6. Web vs. Worker Analysis

**Crawl duration (FACT, from `crawl/shopify.ts`)**: `maxPages=60` × `pageSize=250` = up to 15,000
products of headroom; `requestDelayMs=250ms` between product pages; per-request `timeoutMs=15_000` with
one retry on the *first* page and one retry on every subsequent page on failure. Three "extras" fetches
(bestseller ranks, up to 20 pages of collections, homepage) run concurrently with each other but *after*
the product pages finish. **INFERENCE**: a small store (1-3 product pages) completes in low single-digit
seconds; a large, healthy store (10-30 product pages) plausibly takes 5-20 seconds; a large store hitting
retries or a slow origin could reach 60-120+ seconds; a genuinely pathological case (every page needing
its one retry, close to the 60-page cap) could exceed 5 minutes in the worst case. These are **estimates
from the code's own configured constants, not measured production timings** (no production traffic
exists yet) — flagged as **INFERENCE**, not **FACT**.

**Manual analyze (`POST /api/analyze`)**: already a long-lived Server-Sent-Events response — the request
stays open for the crawl's full duration by design (confirmed in Milestone 7 Sub-phase C's own
completion report, which found and fixed a real bug in this exact stream's disconnect handling). This
is **inherently incompatible with a short serverless timeout** regardless of scheduler concerns — a
user analyzing a large store needs the connection open for as long as that single crawl takes. This is
true today, works today, and doesn't change with this sub-phase's recommendation, but it independently
argues against a tightly-time-limited serverless host for the *web* tier too, not just the scheduler.

**Scheduled crawling (`runSchedulerTick`)**: processes up to `batchSize=10` (Shopify) or `5` (marketing)
claimed stores *sequentially* in one function invocation. **INFERENCE, following directly from the
crawl-duration estimate above**: a worst-case tick (10 large/retry-heavy stores) could take several
minutes — comfortably past Vercel Hobby's 60s and plausibly past Pro's 300s default, though within an
800s Fluid-Compute-beta budget (unverified how stable/generally-available that specific number is —
flagged **ASSUMPTION** if relied upon). A worker host with no hard execution-time ceiling (Render/Fly.io
background workers, or any always-on container) sidesteps this question entirely rather than requiring
the batch size to be tuned defensively against a serverless platform's limit.

**Recommendation — WEB**: Next.js UI, API routes, authentication, report rendering, and the manual-
analyze SSE endpoint. **WORKER**: the two scheduler ticks (Shopify crawl, marketing collection), running
as a small always-on process that calls the *existing* `runSchedulerTick`/`runMarketingSchedulerTick`
functions on a `setInterval` (or the host's native cron primitive) — no new code, no queue. Both
processes share the same Postgres, same Prisma schema, same codebase; only the entrypoint differs. This
is the **minimum mechanism**: no queue is introduced because nothing about the current claim design
needs one (Section 7) — a queue would add a second source of truth about "what's due" that has to stay
consistent with the `nextCrawlAt` column itself, for no capability Bellwether's actual V1 workload needs.

---

## 7. Scheduler Architecture

**Is `FOR UPDATE SKIP LOCKED` sufficient?** — evaluated against every scenario the brief names:

| Scenario | Behavior today | Safe? |
|---|---|---|
| One scheduler process | Claims up to `batchSize`, processes sequentially | Yes |
| Multiple scheduler processes (same or different hosts) | Each transaction's `SELECT ... FOR UPDATE SKIP LOCKED` only ever returns rows no other open transaction is already holding — two processes ticking at the same instant partition the due set between them, never double-claim | Yes — **integration-tested** (`scheduler.integration.test.ts`'s concurrent-tick test) |
| Multiple worker processes | Same as above; the claim step and the "do the crawl" step are decoupled, so any number of workers can pull from the same claim query | Yes |
| Process crash mid-tick | The claim already pushed `nextCrawlAt` forward by `CLAIM_TIMEOUT_MS` (10 min) *before* any crawl work begins — a crashed process simply leaves those stores looking "due again" in 10 minutes, no stuck/lost work, no manual intervention | Yes, self-healing |
| Worker crash mid-crawl (one store) | Same self-heal — that one store's claim window expires and it's picked up again; `Crawl.status` for the interrupted attempt stays `RUNNING` forever (a real, minor gap — Section 19) | Mostly yes — see the one gap below |
| Deployment restart during a tick | Equivalent to a process crash — self-heals via the same claim-timeout | Yes |
| Duplicate execution | Structurally prevented by `SKIP LOCKED`, not merely made unlikely | Yes |
| Overlapping ticks (a slow tick still running when the next cron fire happens) | Each tick's own transaction only sees currently-unlocked due rows — an overlapping tick just claims a *different* batch (or none, if nothing else is due) | Yes |
| Long-running crawls | Bounded by the 10-minute claim-timeout as a soft ceiling — a crawl taking longer than that risks a *second* worker claiming the same store once the window lapses, running two crawls concurrently against it | **Gap — see below** |

**One real, genuine gap (not a STOP condition, but worth fixing before real production cron cadence is
turned on)**: `CLAIM_TIMEOUT_MS = 10 * 60_000` assumes every crawl in a batch finishes well inside 10
minutes. Section 6's own duration analysis shows a pathological single-store crawl could plausibly
approach or exceed that on its own, and a *worker* process crash specifically (not a clean tick
completion) leaves that store's `Crawl` row permanently `RUNNING` — nothing currently sweeps stale
`RUNNING` crawls back to `FAILED`. **Recommendation, not implemented here**: a small, additive
"stale-crawl sweep" (mark any `Crawl` still `RUNNING` past some generous threshold — e.g., 30 minutes —
as `FAILED` with a synthetic `errorMessage`) would close this gap cleanly, reusing the exact same
`FOR UPDATE SKIP LOCKED`-adjacent pattern already proven elsewhere. This is Sub-phase-B-or-C-sized
implementation work, explicitly deferred (Section 31), not attempted in this research-only sub-phase.

**Do we need**: cron (yes — external trigger, whatever the host's native cron primitive is, or a plain
`setInterval` inside an always-on worker process); scheduled HTTP endpoint (already exists,
`SCHEDULER_SECRET`-gated, keep it as a manual/health-check trigger even if the primary path becomes an
in-process interval); dedicated scheduler process (yes, per Section 6 — as the "worker" role, not a
separate *third* role); database-backed scheduler (already is one — `nextCrawlAt`/
`nextMarketingCollectionAt` columns *are* the scheduler's state, no new table needed); external
scheduler service (not needed — the host's own cron or a simple loop is sufficient at this scale).

---

## 8. PostgreSQL Architecture

**Connection pooling — needed?** **FACT**: no pool-size configuration exists in this codebase today
(bare `PrismaClient()`, default settings). **INFERENCE**: for Option B's process shape (one long-running
web process + one long-running worker process, each holding a small, stable number of connections —
Prisma's own default pool sizing is `num_cpus * 2 + 1` connections per client instance, a well-known
Prisma default **not independently re-verified against current Prisma 5.x docs this sub-phase** —
flagged **ASSUMPTION**), a managed Postgres's *default* (unpooled) connection limit is very likely
sufficient for two long-running processes. Connection pooling becomes *necessary*, not optional, only if
the web tier is ever deployed as serverless functions (Option D) or scaled to many concurrent instances
(Section 18) — many short-lived function invocations each opening fresh connections is exactly the
failure mode Neon's/Supabase's built-in PgBouncer exists to prevent (**FACT**, both verified this
sub-phase via live search).

**Prisma behavior**: typed queries (`.create()`, `.findMany()`, etc.) round-trip `Date` correctly
regardless of session timezone (already established project knowledge, `AGENTS.md`); raw SQL does not,
which is why every raw-SQL timestamp write in this codebase already carries an explicit
`AT TIME ZONE 'UTC'` cast (Section 2). This discipline must be preserved for any *new* raw SQL a future
sub-phase adds (e.g., the stale-crawl sweep in Section 7) — already a standing project rule, not a new
one this document introduces.

**V1 recommendation**: one managed PostgreSQL instance. **No connection pooler needed as a separate
piece of infrastructure to operate** — use a Postgres provider with pooling *built in* (Neon or
Supabase) rather than standing up PgBouncer separately, since Bellwether has no existing PgBouncer
expertise or need for pooling behavior beyond what those providers already give for free. **No read
replica** — nothing in the current query patterns (all bounded, all indexed, verified across three
milestones' own `EXPLAIN ANALYZE` audits) shows read pressure that would benefit from one, and a replica
adds real operational complexity (replication lag correctness questions for a historically-sensitive
product) for no demonstrated need. **No separate analytics database** — the existing `Event`/
`ProductStateSnapshot` tables *are* the analytical substrate the product's own intelligence composer
already reads efficiently; splitting them out would be solving a problem that doesn't exist yet.

---

## 9. Database Growth Analysis

**Tables expected to grow fastest (FACT, ordered by write frequency)**: `Event` (append-only, written on
every *detected change*, not every crawl — Section 2's short-circuit means most crawls write zero Event
rows), `ProductStateSnapshot` (same "on-change only" discipline, by explicit schema design comment),
`Crawl` (one row per crawl *attempt*, regardless of whether anything changed — the only table that grows
strictly with crawl frequency, not with catalog churn), `AdObservation`/`MarketingCollectionRun` (bounded
by ad-account size and marketing-tier cadence, both much slower than the Shopify crawl cadence by
design).

**Assumptions used for this estimate** (explicitly labeled, per the brief's own instruction):
- Row-size estimates include typical index overhead: `Crawl` ≈ 300 bytes/row, `Event` ≈ 550 bytes/row
  (it carries the most indexes of any table — 4 — plus two JSON columns), `ProductStateSnapshot` ≈ 150
  bytes/row. **ASSUMPTION** — not measured against a real populated database; a future sub-phase should
  replace these with `pg_total_relation_size()` readings against real production data once it exists.
- **ASSUMPTION**: an average store settles at COLD tier (30-day cadence, `DEFAULT_TIER_ON_BASELINE`) —
  i.e., 12 real crawl attempts/year/store as a baseline, with a minority of actively-monitored (BASIC/
  FREE-watched) stores at faster tiers pulling the blended average up somewhat. This document does not
  attempt to model the HOT/WARM/COOL mix precisely — no real user-behavior data exists yet to calibrate
  it.
- **ASSUMPTION**: on a crawl that *does* detect change (roughly 5%, per `diff/persist.ts`'s own
  short-circuit-rate comment — itself describing the code's design intent, not a measured production
  rate), a modestly-sized store sees on the order of 1-20 products change, each producing one `Event`
  row and (only if that specific product's state changed) one `ProductStateSnapshot` row.

**Rough per-store, per-year storage** (10 changed products/change-crawl × ~0.6 change-crawls/year at
COLD cadence, as an illustrative midpoint — genuinely a coarse estimate):
≈ 12 `Crawl` rows (3.6 KB) + ≈ 6 `Event` rows (3.3 KB) + ≈ 6 `ProductStateSnapshot` rows (0.9 KB) ≈
**under 10 KB/store/year** at COLD cadence. A HOT-tier (actively BASIC-monitored, 8h cadence ≈ 1,095
crawls/year) store with proportionally more real change activity could plausibly reach the
**low-single-digit MB/year** range — still small in absolute terms.

| Stores | COLD-only estimate/year | Mixed-tier estimate/year (ASSUMPTION: 20% HOT, 80% COLD) |
|---|---|---|
| 10 | ~100 KB | ~5-10 MB |
| 50 | ~500 KB | ~25-50 MB |
| 100 | ~1 MB | ~50-100 MB |
| 500 | ~5 MB | ~250 MB - 0.5 GB |
| 1,000 | ~10 MB | ~0.5-1 GB |

**These are order-of-magnitude planning numbers, not a forecast.** The real driver is the HOT/BASIC-
monitored fraction and each store's actual real-world change rate, neither of which can be known before
real users and real stores exist. The practical implication is the same regardless of exact numbers:
**storage growth is not a near-term production risk at V1 scale** — even the pessimistic end of this
range fits comfortably inside any managed Postgres provider's smallest paid tier (typically 10+ GB
included, Section 17).

---

## 10. Retention Strategy

**Recommendation: retain indefinitely for V1. Do not implement retention, archival, or aggregation now.**

Reasoning, directly from the brief's own constraint that retention must preserve what growth signals,
bestseller trajectory, persistence, technology-change history, and monitoring/marketing activity all
depend on:

- `Event`: **the product's actual asset** — the Competitor Timeline *is* this table (Milestone 7
  research doc, previously established). Deleting old events deletes user-visible product value
  directly, not just storage. Given Section 9's own finding that storage growth is not a near-term
  concern, there is no cost pressure forcing this decision before it can be made deliberately with real
  usage data.
- `ProductStateSnapshot`: already storage-optimized by construction (on-change only) — the lowest-
  priority retention candidate, by a wide margin, since it's already sparse.
  `getBestsellerSignal`/`getProductPersistence` both already cap their *read* window
  (`MAX_RANK_SNAPSHOTS=20`, `PERSISTENCE_WINDOW_CRAWLS=20`) regardless of how much history exists, so
  even unbounded accumulation here doesn't translate into unbounded *query* cost (already verified,
  Milestone 7 Sub-phase D).
- `Crawl`: the temporal backbone every other table's correctness depends on (the `finishedAt`-vs-
  `startedAt` distinction that Milestone 5 Sub-phase C's real bug fix depended on). Never delete `Crawl`
  rows without first confirming no downstream query implicitly assumes a contiguous crawl history.
- `AdObservation`/`MarketingCollectionRun`: smallest tables by row count (bounded by ad-account size and
  slow marketing cadence), lowest urgency by a wide margin.

**If retention is ever needed** (e.g., a future real-world storage-cost pressure this document cannot
currently see), the right *shape* — not implemented here — is compaction (collapsing old low-
significance `Event` rows into a periodic summary) rather than deletion, since deletion directly
destroys the historical-intelligence product surface. This mirrors the conclusion Milestone 7's own
research doc already reached independently; this sub-phase found no new evidence to revise it.

---

## 11. Crawler Resource Controls

Every control already exists in code (Section 2/6); this section maps them to the brief's named
scenarios rather than proposing new ones — **the crawler already fails safely, verified by direct
re-read this sub-phase**:

| Scenario | Existing control |
|---|---|
| Small store | Terminates naturally at the first short page (`reachedEnd` on `products.length < pageSize`) — no wasted requests |
| Large store | Bounded at `maxPages=60` (15,000 products); collections separately bounded at 20 pages (5,000 collections, confirmed against a real store — allbirds.com has 1,345) |
| Broken store | Every fetch has a 15s timeout + one retry; malformed JSON, non-Shopify responses, and bot-challenge pages are all classified distinctly, never silently treated as "0 products" |
| Hostile endpoint | SSRF guard rejects before the first request; every redirect hop re-validated; response bodies are only ever `.text()`-then-`JSON.parse()`d for known endpoints, never executed |
| 100,000+ product store | Hits `maxPages=60` and stops with `httpErrors` incremented (routed through the same signal `normalizeSnapshot()` already reads as "removal detection can't be trusted this crawl") — a real, honest partial result, not a crash or an unbounded fetch loop |
| Store returning unexpectedly large responses | **Not independently verified this sub-phase** — no explicit byte-size cap was found on the raw response body read (`res.text()`) in `crawl/shopify.ts`. This is a real gap worth flagging (not a STOP condition — no evidence of active exploitation risk, since SSRF already prevents targeting anything but a real external Shopify storefront, and Shopify's own `/products.json` response size is bounded by the `limit` query param this code itself controls) but is not something this research-only sub-phase should silently patch. **Flagged for Sub-phase B/C implementation consideration.** |

**Do not weaken**: none of the above are recommended for relaxation. **SSRF protection specifically
should not be touched** — it is already allowlist-based, already the strongest reasonable posture
without closing the documented DNS-rebinding gap (which would require a custom fetch dispatcher pinning
the resolved IP — real, scoped future work, not a quick fix, and not evidence of an *active* risk today
since no production traffic exists to have been attacked).

---

## 12. External Vendor Dependencies

| Vendor | Data depended on | If unavailable | Timeout/retry | Rate limit | Cost | Credential | Blocks Store Intelligence report? |
|---|---|---|---|---|---|---|---|
| Shopify storefronts (crawl target, not a "vendor" in the billing sense) | Product catalog, theme, apps, pixels, payment providers | Crawl fails with a classified reason (`blocked`/`not_found`/`error`) — store-specific, never global | 15s/request, 1 retry, honors `Retry-After` | None imposed by us beyond `requestDelayMs=250ms` politeness delay | Free | None | No — affects only that one store |
| SerpApi (Google Ads Transparency Center) | Advertising presence/format/region/timing | `marketing/report.ts` returns honest `UNAVAILABLE` with a real reason — **verified architecturally already correct**: marketing collection is a fully separate pipeline (own `Crawl`-equivalent `MarketingCollectionRun`, own cadence, own claim column) from the Shopify crawl, so a SerpApi outage cannot touch the Shopify-derived sections of a report at all | Whatever SerpApi's own API client enforces (not independently re-verified this sub-phase — **ASSUMPTION** that `sources/google-serpapi.ts`'s existing timeout handling, established in Milestone 4, remains adequate) | **FACT, this sub-phase's live search**: plans cap throughput at 20% of monthly volume/hour; no pay-as-you-go, must commit to a monthly tier in advance | **FACT**: Free 250 searches/mo; $25/mo=1,000; $75/mo=5,000; $150/mo=15,000; $275/mo=30,000 (see Section 17) | `SERPAPI_API_KEY`, currently a real value in local `.env` (correctly gitignored) | **No** — confirmed by design and by this sub-phase's own re-read of `marketing/report.ts`: `productMatching`/`adSpend`/`impressions`/`conversions` are hard-coded `UnavailableField` constants, never computed from vendor state |
| Google/Facebook OAuth | Optional sign-in identity | App runs fine without them (`configuredProviders` gate) | N/A (browser redirect flow) | Provider-specific, not evaluated | Free | `GOOGLE_CLIENT_ID/SECRET`, `FACEBOOK_CLIENT_ID/SECRET` — none configured today | No |
| Future: payment provider | Subscription/billing state | N/A — doesn't exist yet | — | — | — | — | Must not, by the same "degrade gracefully" principle (Section 23) |
| Future: email provider | Alerts/digests/transactional | N/A — doesn't exist yet | — | — | — | — | Must not (Section 24) |

**The stated principle — "SerpApi failure must NOT destroy the Shopify intelligence report" — is already
true today**, not a future requirement. Verified by direct re-read of `marketing/report.ts` and
`intelligence/report.ts`'s composer, which calls `buildFullStoreReport()`, `buildGrowthReport()`, and
`buildMarketingReport()` concurrently via `Promise.all` — a failure inside `buildMarketingReport()`
(itself already designed to catch vendor failures and return an honest `UNAVAILABLE` shape rather than
throw) cannot affect the other two. Any *future* vendor should be integrated behind the same pattern:
its own failure-tolerant report-builder function, composed alongside the others, never allowed to throw
past its own boundary.

---

## 13. Environment Strategy

Full inventory of every environment variable found in the codebase this sub-phase (grep across `.env`,
`.env.test`, `.env.test.example`, and every `process.env.` reference in `src/`):

| Variable | Classification | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | **SECRET** (contains credentials) | Prisma client, everywhere | Different value per environment, never shared |
| `AUTH_SECRET` | **SECRET** | Auth.js JWT signing | Must be unique per environment — a shared secret across environments lets a staging-issued JWT authenticate against production |
| `SERPAPI_API_KEY` | **SECRET** | `marketing/source-factory.ts` | Real vendor billing tied to this key — must never leak into a public repo or client bundle |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ID: **SERVER-ONLY** (not sensitive alone) / Secret: **SECRET** | `auth.ts` | Optional — app degrades gracefully when absent |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | Same split as Google | `auth.ts` | Same optionality |
| `SCHEDULER_SECRET` | **SECRET** | Both `/api/internal/scheduler/*` routes | **Gap found this sub-phase**: referenced in code and comments, but documented in *neither* `.env.test.example` nor any committed example file — a real, small documentation gap (Section 31) |
| `NODE_ENV` | **PLATFORM-MANAGED** | `db/prisma.ts` (dev-mode singleton caching) | Set automatically by `next build`/`next start`/most hosts — not something a developer sets by hand |

**No `PUBLIC` (i.e., `NEXT_PUBLIC_*`) environment variable exists anywhere in the codebase** — confirmed
by grep. This is worth noting: the entire app currently ships zero client-exposed configuration, which
is a clean starting position for adding any future public config carefully rather than by habit.

**Production requirements**:
- `DATABASE_URL`: the managed Postgres provider's connection string (pooled variant if the web tier is
  ever serverless — Section 8).
- `AUTH_SECRET`: freshly generated per environment (`openssl rand -base64 32`, per the existing
  `.env.test.example`'s own comment), never reused.
- OAuth credentials: real Google/Facebook app credentials, registered with real production callback
  URLs (Section 15) — a distinct concern from the `AUTH_SECRET` itself.
- `SERPAPI_API_KEY`: a real, billed key — should be a *different* key (or at minimum a separate SerpApi
  account/plan) from whatever a developer might use for ad-hoc local testing, so local experimentation
  never risks consuming production quota (Section 12's throughput cap makes this more than a hygiene
  preference).
- `SCHEDULER_SECRET`: a freshly generated, long random value — this is the credential standing between
  "anyone on the internet" and "trigger real outbound Shopify crawls / real billed SerpApi calls,"
  per the route's own fail-closed design.
- Future billing secret (Stripe or similar): not needed until Section 23's work begins.
- Future email credentials: not needed until Section 24's work begins.

**Recommended secrets-management approach**: **platform environment variables** — i.e., whatever
built-in encrypted-env-var mechanism the chosen host provides (Render/Fly.io/Vercel all have one,
**FACT** for all three, standard PaaS capability, not independently re-verified per-platform this
sub-phase beyond general knowledge). A dedicated secrets manager (AWS Secrets Manager, HashiCorp Vault,
Doppler) is explicitly **not recommended for V1** — the brief's own "do not overengineer... practical V1
solution" instruction, and nothing about Bellwether's current secret count or rotation requirements
justifies the added operational surface a dedicated secrets manager brings. Revisit only if a compliance
requirement (e.g., SOC 2, during a future enterprise-sales motion) forces it.

---

## 14. Secrets Strategy

(Continued from Section 13 — kept as its own section per the required document structure, since the
brief separates "Environment Strategy" from "Secrets Strategy" even though they overlap heavily in this
codebase's actual shape.)

**Never shared between environments** (explicit list, per the brief's Section 12 requirement):
`AUTH_SECRET` (a shared value would let a staging session token authenticate in production), 
`DATABASE_URL` (obviously — staging and production must never point at the same database), OAuth client
credentials (production OAuth apps must use production callback URLs — Section 15 — so a shared
credential would either break staging or misconfigure production), any future billing credential (a
shared Stripe key would let staging tests create real charges), `SERPAPI_API_KEY` (a shared key means
local/staging experimentation consumes real, billed production quota — directly costly given Section 12's
"no pay-as-you-go, commit to a monthly tier" constraint).

**Safe to share or intentionally differ by design**: `SCHEDULER_SECRET` could technically be shared
without a security consequence (it only gates *triggering* a tick, not data access), but should still be
generated per-environment as a matter of hygiene, not because sharing it is unsafe. `NODE_ENV` differs by
design (platform-managed, not a developer decision).

---

## 15. Domain/HTTPS Requirements

No domain was configured or purchased — this section documents *what will be needed*, not a
configuration performed.

**Configurable URLs that must exist per-environment** (not hardcoded anywhere in the current
codebase — confirmed by grep for any hardcoded `https://` production-looking URL: none found beyond the
crawler's own dynamic `https://${domain}` construction and the bot User-Agent string's placeholder
`https://example.com/bot`, which itself should be updated to a real bot-info page before any real
production crawling begins):

- **Application base URL** — needed by Auth.js for constructing OAuth callback URLs and any future
  absolute-link generation (emails, webhooks). Auth.js v5 typically infers this from the request itself
  in most deployments, but an explicit `AUTH_URL` (or host-equivalent) is standard practice for
  production — **not currently configured anywhere**, since none is needed for `next dev`.
- **OAuth callback URLs** — `https://<production-domain>/api/auth/callback/google` and
  `.../facebook`, registered in each provider's own developer console — a real, one-time manual
  configuration step for whichever domain is chosen.
- **Billing webhook URL** (future, Section 23) — `https://<production-domain>/api/webhooks/<provider>`,
  not yet built.
- **Scheduler webhook URL**: already exists in *shape* (`/api/internal/scheduler/tick`,
  `/api/internal/scheduler/marketing-tick`) — needs only a real domain to be pointed at from whatever
  cron mechanism is chosen.
- **Email sending domain** (future, Section 24): a subdomain (e.g., `mail.<domain>` or
  `notifications.<domain>`) is standard practice so DNS/deliverability issues never touch the main
  application domain's reputation — not yet needed.

**HTTPS**: every host under serious consideration (Render, Fly.io, Vercel) provisions TLS automatically
for custom domains — **FACT** for Vercel and Render (well-established, standard PaaS capability, not
independently re-verified per-platform this sub-phase beyond general knowledge); should be confirmed
for whichever host is actually chosen before Phase C (Section 24 roadmap).

**Cookies**: Auth.js's JWT cookie is already configured with sane defaults by the library itself
(httpOnly, secure-in-production) — no custom cookie configuration exists or is currently needed.

---

## 16. Local/Staging/Production Architecture

| | LOCAL | STAGING | PRODUCTION |
|---|---|---|---|
| Compute | Developer machine, `next dev` | Same host type as production, smaller instance size (ASSUMPTION: sizing is a Phase B decision) | Production-sized instances (web + worker) |
| Database | Local/embedded/test Postgres (already the established pattern — this session's own repeated use of a disposable embedded-Postgres instance for integration testing) | A real managed Postgres instance, separate from production, safe to reset/reseed | A real managed Postgres instance, backed up, never manually reset |
| OAuth | Test app credentials, or omitted entirely (app degrades gracefully) | Test/sandbox app credentials pointed at the staging domain | Real, production-registered app credentials |
| SerpApi | A real key, but ideally a separate low-tier/free plan to avoid consuming paid quota during development | A real key, separate from production, low-tier | Real, billed production key |
| Billing | N/A — doesn't exist yet | Sandbox/test-mode credentials once billing exists (Section 23) — **no real customer billing in staging, per the brief's own explicit instruction** | Real, live billing credentials |
| `AUTH_SECRET` | Local-only value | Unique to staging | Unique to production |
| Scheduler | Manual script invocation or OS-level cron, low frequency | Real cron, same cadence logic as production, against staging data only | Real cron, production cadence |

**Never shared between environments** (restated from Section 14, since the brief asks for it again
here specifically in the environment-topology context): `AUTH_SECRET`, database, OAuth credentials,
billing credentials, vendor credentials. **Staging's specific purpose**: prove the *deployment*
mechanism (the thing that doesn't exist today) works — build process, environment-variable wiring,
scheduler cron actually firing, migrations actually applying — against infrastructure that mirrors
production shape, before any of that is trusted with real user data or real billing.

---

## 17. Prisma Migration Strategy

**Current state (FACT)**: 8 migrations exist under `prisma/migrations/`, applied via
`prisma migrate deploy` in every environment this project has used so far (confirmed: `db:test:migrate`
script, and every sub-phase this session explicitly ran `prisma migrate deploy` — never `db push` —
against the disposable test Postgres). This is already the correct production pattern; nothing needs to
change about *how* migrations are authored.

**Requirements, confirmed already satisfied by existing practice**:
- **Migrations only, no `db push` in production** — already the established convention; this document
  recommends continuing it explicitly, not introducing it.
- **Migration history preserved** — the 8 existing migration files under version control already
  constitute this; nothing new needed.
- **Rollback strategy** — **not currently documented anywhere** (a real gap). Prisma's own migration
  model does not auto-generate a "down" migration; the practical rollback strategy for a destructive
  migration in production is: restore from a pre-migration backup (Section 6's database, whichever
  provider is chosen, needs point-in-time-recovery or at minimum scheduled snapshots enabled — **not
  independently verified per-provider this sub-phase which tier includes this**, flagged as a concrete
  question for whoever picks the final Postgres provider) rather than a scripted "undo." This should be
  written down explicitly before the first production migration runs, not discovered during an incident.
- **Backup before destructive migrations** — a manual/scripted step to add to the deployment process
  (Phase C, Section 28 roadmap), not something that exists today.

**Initial database creation**: `prisma migrate deploy` against a freshly-provisioned empty database,
exactly like every one of this session's own disposable test-Postgres setups — the process is already
proven, just never run against a *persistent* target.

**Seed strategy**: no seed script exists in this codebase today (`scripts/set-user-plan.ts` is a
developer utility for changing an *existing* user's plan locally, not a seed script). **Recommendation**:
none needed for V1 — the product's own "corpus" (analyzed stores) grows organically from real user
activity; there is no fixed reference data (e.g., a plans table, a countries table) that would benefit
from seeding.

**Admin/dev account strategy**: no admin role or elevated-privilege concept exists anywhere in the
current schema or auth code (`User.plan` is the only differentiator, and it's a product-tier concept,
not an authorization-tier one). **Not required for V1** per this document's own scope (no admin UI is
planned); flagged as an open question (Section 30) for whenever operational need for one arises (e.g.,
manually adjusting a user's plan in production — today this requires direct database access via
`scripts/set-user-plan.ts`-equivalent tooling, acceptable at V1's expected support volume).

---

## 18. Observability

**Minimum V1 observability, by category** (per the brief's own breakdown) — **what's needed**, not what
tool to install (Section 19 stays deliberately tool-agnostic per "do not overengineer"):

- **Application**: request errors and 500s (needed to know the app is broken at all), authentication
  failures (needed to distinguish "a real attack" from "a user mistyped their password" at volume),
  API latency (needed to know if the app is slow before a user complains), SSE failures (specifically
  relevant given the real bug Milestone 7 Sub-phase D found in this exact code path).
- **Crawler**: crawl started/completed/failed, duration, products discovered, pages fetched, retry
  count, failure classification (`invalid`/`blocked`/`not_found`/`error`) — **all of this data already
  exists on the `Crawl` row itself** (`status`, `durationMs`, `productCount`, `pagesFetched`,
  `httpErrors`, `errorMessage`) — V1 observability for the crawler is substantially just *querying and
  alerting on data the schema already captures*, not a new instrumentation project.
- **Scheduler**: tick started/stores claimed/completed/failed, stale jobs, scheduler failures — the tick
  functions already *return* this exact shape (`SchedulerTickResult`/`MarketingSchedulerTickResult`);
  V1 observability here is "log/forward this return value somewhere queryable," not new instrumentation.
- **Marketing**: vendor requests/failures/latency/collection counts — same story:
  `MarketingCollectionRun.vendorRequestCount`/`outcome`/`reason` already exist on the row.
- **Database**: connection failures, slow queries, storage — this is the one category genuinely outside
  the application's own code; needs the chosen Postgres provider's own dashboard/metrics (every serious
  managed-Postgres provider ships this — **FACT** for the general category, not independently
  re-verified per-provider's exact feature set this sub-phase).
- **Business**: analyses, active watches, FREE vs. BASIC users, failed conversions, subscription events
  (once billing exists) — all directly queryable from existing tables (`AnalysisUsage`, `Watchlist`,
  `User.plan`) with no new instrumentation; a simple periodic query/dashboard, not a new data pipeline.

**Minimum tools/services needed (not installed this sub-phase)**: one error-tracking service (Sentry or
similar — industry-standard, not independently re-verified/chosen this sub-phase) for the "Application"
category's 500s/exceptions, since `console.error` alone (the current state) has no alerting or
aggregation; everything else in the table above can start as **structured log output plus direct
database queries**, genuinely deferring a dedicated metrics/APM product until real production traffic
exists to justify its cost.

---

## 19. Logging

**Current state (FACT)**: every log call in the codebase is a plain `console.log`/`console.error`, no
structured format, no request/crawl/store correlation ID threading. This is adequate for local
development (which is all that exists today) and **not adequate for production debugging** once
multiple concurrent requests/crawls are in flight and a human needs to find "everything related to this
one failed crawl" in a log stream.

**Recommended minimal structured format** (not implemented this sub-phase, since the brief only asks to
implement it "if the current logging has a serious production blocker" — it does not; `console.error`
calls already exist at every meaningful failure point, they're just unstructured):
`{ level, timestamp, event, storeId?, crawlId?, userId?, schedulerRunId?, message, ...context }` — a
single flat JSON object per line, so any log aggregator (even just `grep`+`jq` against raw platform
logs, which is sufficient at V1 volume) can filter by any of the correlation IDs already present as
columns on `Crawl`/`Store`/`User` today.

**Never log** (restated per the brief's explicit list, cross-checked against current code — **FACT: no
violation found** by grep for `console.log`/`console.error` calls anywhere near `password`, `token`,
`secret`, `apiKey`): passwords (already never logged — `verify-credentials.ts` only ever compares a
bcrypt hash, never logs the plaintext, confirmed by an existing test: "never stores the plaintext in the
hash"), OAuth tokens, session secrets, API keys, payment secrets (don't exist yet), sensitive user
information. This is already the codebase's practice, not a gap to close.

---

## 20. Alerting

Defined by severity, matching the brief's three-tier scheme, using data already captured (Section 18) —
**not implemented, a specification for Phase G**:

**CRITICAL** (page someone immediately): scheduler has not completed a successful tick in N hours
(implies the worker process itself is down, not just individual store failures); database unreachable;
`SCHEDULER_SECRET`-gated route seeing repeated 401s at volume (possible credential compromise or
misconfiguration); application 5xx rate spikes past a threshold.

**WARNING** (needs attention, not urgent): crawler failure *rate* (not count — a handful of genuinely
broken external stores is normal and expected) spikes above a baseline; SerpApi authentication failure
(401) — distinct from "no ads found," a real vendor-credential problem; SerpApi quota/rate-limit
exhaustion (Section 12's hard monthly-commitment model makes this a real, bounded risk worth watching
proactively, not discovering via a failed collection); SSRF-guard rejection rate spike (could indicate
either a wave of genuinely malicious submitted URLs or a legitimate bug misclassifying safe ones —
either way, worth a human look); authentication failure rate spike (credential-stuffing signal).

**INFO** (dashboard-visible, not paged): normal scheduler tick summaries; new-user signups; plan
upgrades (once billing exists).

**Explicitly avoid** (per the brief's "do not create noisy alerts" instruction): alerting on any single
store's crawl failure (expected, routine — the whole point of the failure-backoff/DISABLED-demotion
policy already in `monitoring/policy.ts` is that this is a handled, not exceptional, case); alerting on
the *first* SerpApi `UNAVAILABLE` outcome for a given store (also routine, already handled gracefully by
design, Section 12).

---

## 21. Security

Reviewed against the brief's exact checklist — **every item already correctly implemented, verified by
direct re-read this sub-phase; no weakening recommended or found**:

| Control | Status |
|---|---|
| SSRF | Allowlist-based, redirect-re-validated (Section 2/11) |
| DNS rebinding | Documented residual gap, not closed — explicitly accepted, not hidden |
| Private IP protection | Part of the same allowlist check (`ipaddr.js` "unicast" classification) |
| Redirect protection | Every hop re-validated, capped at 5 |
| Response-size limits | **Gap** — no explicit byte cap found on crawler response bodies (Section 11) |
| Rate limiting | Works correctly for one instance; **not multi-instance-safe by the code's own admission** (Section 2) — a real constraint on horizontal web scaling (Section 18), not a security hole at V1's single-instance scale |
| Authentication | Auth.js v5, bcrypt-hashed Credentials passwords, JWT sessions | 
| Authorization | Server-side only, verified at every route (`requireUser()`/`getCurrentUser()`), never trusted from client-supplied state — confirmed by the extensive cross-user isolation test suite (Milestone 3 through 7) |
| Cookie security | Auth.js defaults (httpOnly, secure-in-production) |
| CSRF | Auth.js's own built-in CSRF protection for its endpoints (**FACT**, standard Auth.js behavior, not independently re-audited line-by-line this sub-phase); API routes accepting mutations require an authenticated session, not a bearer of a guessable URL |
| Secret storage | `.env`-file-based locally, correctly gitignored; no production secrets-manager decision made yet (Section 13) |
| Database access | Single `DATABASE_URL`, no per-role database credentials — acceptable at V1's single-application-identity scale |
| Scheduler endpoint protection | `SCHEDULER_SECRET`, fail-closed if unconfigured (Section 2) |
| Webhook verification | N/A — no webhooks exist yet (Section 23/24) |
| Vendor credential protection | `SERPAPI_API_KEY` server-only, never sent to the client, confirmed by grep for any client-bundle reference |

**Missing production controls identified, not implemented** (per the brief's own "do not implement
unless absolutely required to prevent a known critical vulnerability" instruction — none of these rise
to that bar at V1's current, pre-launch state): crawler response-size cap (Section 11); a stale-`RUNNING`-
crawl sweep (Section 7, an operational-correctness gap, not a security one); production rate limiting
becoming multi-instance-safe (Section 18, only matters once the web tier scales past one instance).

**No critical security problem was found.** No STOP condition was triggered by this section.

---

## 22. Failure Scenario Analysis

| # | Scenario | Current behavior | Safe? | Data impact | User impact | Production improvement needed? |
|---|---|---|---|---|---|---|
| 1 | Web process crashes | Requests fail (connection reset); no partial writes since all persistence is transactional | Yes | None — transactions either commit or don't | Failed page load/request, retry works once the process restarts | A host with auto-restart (every PaaS under consideration has this) |
| 2 | Worker crashes during crawl | That crawl's `Crawl` row stays `RUNNING` forever (Section 7 gap); the store re-enters the due-set after the 10-min claim-timeout and gets retried | Mostly — no corrupted data, but a cosmetic stuck-`RUNNING` row accumulates | Minor (a stale status field, not wrong intelligence) | None directly — the store just gets crawled again shortly after | Stale-crawl sweep (Section 7) |
| 3 | Scheduler crashes | Simply stops ticking until restarted/redeployed; no due stores are lost (they stay due) | Yes | None | Monitoring falls behind schedule until the worker comes back | Alerting (Section 20) so this is noticed promptly, not silently |
| 4 | Database temporarily unavailable | Every DB-touching request/tick fails with an error; nothing corrupts (Postgres itself guarantees this) | Yes | None | Errors surfaced to users during the outage | Managed Postgres provider's own uptime SLA; retry-with-backoff at the application layer is not currently implemented for transient DB errors — **a real, small gap**, not evaluated further this sub-phase |
| 5 | Shopify store unavailable | Classified `error`/`not_found`/`blocked`, `failureStreak` increments, exponential backoff engages, eventual `DISABLED` demotion after 5 consecutive failures | Yes | None — no data written for a failed crawl | User sees an honest failure message (existing `ErrorPanel` states) | None |
| 6 | Shopify store returns 429 | Honored via `Retry-After` header parsing, one retry | Yes | None | Transparent — usually resolves within the crawl itself | None |
| 7 | Shopify store returns malformed data | Classified as `error` (invalid JSON) or `not_found` (no products array) | Yes | None | Honest failure message | None |
| 8 | SerpApi unavailable | `MarketingCollectionRun.outcome = UNAVAILABLE`, reason recorded, Shopify report unaffected (Section 12) | Yes | None | Advertising section shows honest "not available," rest of report unaffected | None |
| 9 | SerpApi returns 401 | Not independently re-verified this sub-phase how the current adapter classifies this specifically — **ASSUMPTION** it falls into the same `UNAVAILABLE` path as any other vendor error, based on `source-factory.ts`'s fail-closed design philosophy | Likely yes | None | Same as #8 | Should be a WARNING alert (Section 20), since 401 specifically signals a credential problem distinct from routine unavailability |
| 10 | SerpApi rate limit reached | Same `UNAVAILABLE` path (assumed, not re-verified this specific case) | Likely yes | None | Same as #8 | Same WARNING-alert recommendation |
| 11 | Deployment happens during crawl | The in-flight request/tick is interrupted the same as scenario 1/2 — self-heals via the claim-timeout | Yes | None | That store's analysis fails once, user can retry; scheduled crawls just retry automatically | A graceful-shutdown drain (finish in-flight requests before terminating) is standard PaaS behavior, not independently verified per-platform this sub-phase |
| 12 | Two workers claim the same store | Structurally prevented by `FOR UPDATE SKIP LOCKED` — cannot happen | Yes | N/A | N/A | None |
| 13 | Two users analyze the same store simultaneously | Both crawls proceed independently (no lock between *manual* analyze requests, only between *scheduler* claims); `Crawl` rows are independent, diff/persist is idempotent per crawl — the second crawl's diff runs against whatever state the first one already committed | Yes, though potentially wasteful (two real crawls of the same store in quick succession) | None — no corruption, just redundant work | Both users get a correct report | Acceptable at V1 volume; a dedup mechanism (Section 31, deferred) would be a future efficiency improvement, not a correctness fix |
| 14 | User closes browser during SSE analysis | **Fixed in Milestone 7 Sub-phase D** — the crawl completes and persists regardless; the (previously buggy, now fixed) stream-cancellation handling means no false error is logged | Yes | None — crawl still persists | User simply doesn't see the result of a run they abandoned; revisiting the store later shows the persisted result | None — already fixed |
| 15 | User loses internet connection | Same as #14 from the server's perspective (looks identical to closing the browser) | Yes | None | Same as #14 | None |
| 16 | Database connection pool exhausted | **Not evaluated this sub-phase against real load** — no explicit pool-size configuration exists (Section 8), so behavior under real exhaustion is untested. **ASSUMPTION**: Prisma's default client-side pool sizing plus a single long-running web process and a single long-running worker process (Section 6 recommendation) keeps total connection count low enough that this scenario is unlikely at V1 traffic — but this is inference from process count, not a measured guarantee | Unverified | Unknown | Unknown | Worth a real load test before real production traffic, not before |

---

## 23. Billing Architecture Preparation

**Not implemented.** Architecture-only, per the brief's explicit instruction.

**Where subscription state should live**: `User.plan` (the existing `PlanTier` enum: `FREE | BASIC |
BUSINESS`) is **sufficient as the entitlement-facing value** — every existing entitlement check
(`plan-limits.ts`, `entitlement-service.ts`) already reads from exactly this field, and nothing about
adding billing needs to change *how* entitlement decisions are made. What's missing is the *provenance*
of that value: today it's set directly (e.g., via `scripts/set-user-plan.ts` in dev); a real billing
integration needs a second, additive concept — a `Subscription` (or similarly named) table recording the
billing provider's own subscription ID, status, current period end, and which `User` it belongs to — so
a webhook event can update `User.plan` *derived from* that record rather than being the record itself.
**This would be a new Prisma model — explicitly not created in this research-only sub-phase**, flagged
here as the anticipated shape for whichever future sub-phase implements billing.

**How webhook events should update it**: a billing-provider webhook (Stripe is the de facto standard for
this shape of subscription business — **not independently evaluated/chosen this sub-phase**, named only
as the common default) fires on subscription created/updated/canceled/payment-failed; the webhook
handler verifies the provider's signature (a security requirement this document flags but does not
implement), upserts the `Subscription` row, and derives the resulting `User.plan` value from the
subscription's current status (e.g., `active` → `BASIC`, `canceled`/`past_due` past a grace period →
`FREE`). This keeps `User.plan` a fast, denormalized read for every existing entitlement check while
the `Subscription` table remains the actual source of truth.

**Is `User.plan` sufficient?** Yes, as the *read* side. It is not sufficient as the *write* side once
real subscriptions exist — that's exactly the gap the `Subscription` table (Section above) fills.

**Do subscription IDs need to be persisted?** Yes — without persisting the provider's own subscription
ID, there is no way to correlate an incoming webhook event back to a specific `User`, and no way to
handle the provider's own dashboard/support tooling referencing "this subscription" unambiguously.

**Cancellations/downgrades**: should not immediately revoke access — standard practice (and what most
users expect) is access continues through the already-paid-for period, with `User.plan` demoted only
once that period actually ends (mirrors the exact pattern this codebase already uses for FREE's 30-day
monitoring expiry — `expireDueWatches()` in `monitoring/watch.ts` — so the *mechanism* for "something
time-bound eventually lapses and demotes state" already exists in this codebase for an unrelated
feature and could plausibly be reused/mirrored, not invented from scratch).

**Failed payments**: should trigger a grace period (a few days, provider-dependent), not immediate
downgrade — avoids punishing a user for a transient card-decline before they've had a chance to update
payment info. The exact grace-period length is a product decision, not an architecture one, and is
explicitly not decided here.

**No schema change was made.** This section is entirely forward-looking architecture, per the brief's
explicit "do not modify the schema" instruction for this sub-phase.

---

## 24. Email Architecture Preparation

**Not implemented.**

**Anticipated use cases** (from the brief): monitoring alerts (a significant change detected on a
watched store — the `Event.significance`/`Watchlist.alertThreshold` fields already exist in the schema
for exactly this, unused today), weekly digests (`Watchlist.lastDigestAt` also already exists, unused),
watch-expiration reminders (FREE's 30-day monitoring lapsing — currently only surfaced in-app via
`SubscriptionCTA`, never proactively emailed), welcome email, billing emails (once Section 23 exists).

**What email architecture would fit V1**: a transactional email API (Resend, Postmark, or similar —
**FACT, this sub-phase's live search**: Resend's free tier is 3,000 emails/month capped at 100/day on
one domain, Pro $20/month for 50,000 — more than sufficient for V1's realistic volume given the current
user-count scale this document is planning around, Section 17), triggered directly from application
code (a scheduled digest job would live in the *same* worker process recommended in Section 6, not a
new infrastructure piece) rather than a dedicated email-queue service. No new infrastructure category is
needed — this is squarely "one more vendor API call from code that already exists" (the scheduler
already runs on a cadence; a digest job is structurally the same shape as the existing crawl/marketing
ticks).

**Not implemented, not scheduled, no code added this sub-phase.**

---

## 25. Cost Model

**Explicit caveat, per the brief's own instruction**: figures below are drawn from this sub-phase's live
web research (cited in Sections 3/4/8/12/24) where available, otherwise clearly marked as an estimate or
unknown. Actual bills depend on real usage patterns no production traffic yet exists to measure.

| Monitored stores | Web+worker compute (Render/Fly.io) | Postgres (Neon/Supabase) | SerpApi | Email (Resend) | Observability | **Rough total/month** |
|---|---|---|---|---|---|---|
| 10 | ~$14-20 (2 small always-on services, Render's $7/mo tier each, **FACT**-cited Section 3; or Fly.io's ~$2-10/mo per small machine, **FACT**-cited Section 3) | $0-25 (free tier plausibly sufficient at this scale — Supabase free tier explicitly exists, **FACT**; Neon's free tier was not independently re-confirmed this sub-phase — **ASSUMPTION**) | $0-25 (Free tier's 250 searches/mo likely sufficient at 10 stores' worth of COLD/WARM marketing cadence — rough math, not precisely modeled) | $0 (free tier) | $0 (free tier of most error trackers at this volume — not independently verified per-vendor) | **~$15-70** |
| 50 | ~$14-20 | $25 (Supabase Pro, or Neon's paid tier once free-tier storage/compute is exceeded) | $25-75 | $0 | $0-26 | **~$65-145** |
| 100 | ~$14-30 (may need a slightly larger instance) | $25-80 | $75-150 | $0 | $0-26 | **~$115-285** |
| 500 | ~$30-70 (larger instances, Section 18 Stage 2/3 territory) | $80-150 (ASSUMPTION — storage/compute scaling beyond this sub-phase's precisely-cited numbers) | $150-275 | $0-20 | $26+ | **~$285-590** |
| 1,000 | ~$50-100 | $150-300 (ASSUMPTION) | $275-1,475 (wide range — depends heavily on actual marketing-collection cadence mix, Section 9's same HOT/COLD-mix uncertainty applies directly to vendor-call volume) | $0-20 | $26-50 | **~$500-1,900** |

**The dominant, least-certain cost driver at real scale is SerpApi** (Section 12's hard monthly-
commitment model, no pay-as-you-go), not compute or database — worth the actual product team's attention
disproportionate to how this document has otherwise treated it, since a doubling of the monitored-store
count could plausibly require jumping an entire SerpApi pricing tier rather than scaling smoothly.
**This is the cost line most worth revisiting with real usage data before Stage 2 (Section 18).**

**Explicitly not fabricated**: no vendor's exact V1-relevant discount/negotiated pricing was assumed;
every number above traces to either a cited live search result (Sections 3/4/8/12/24) or is marked
ASSUMPTION where it doesn't.

---

## 26. Scaling Model

| Stage | Stores | Web/worker | Scheduler | Redis/queue | DB | Read replica | Crawler proxy infra | Separate marketing workers |
|---|---|---|---|---|---|---|---|---|
| 1 | 0-50 | 1 web + 1 worker instance (Section 6/27) | Single worker, existing claim mechanism | No | Single managed instance, no pooler needed beyond the provider's built-in one | No | No | No |
| 2 | 50-200 | Possibly 2 web instances (still 1 worker — the worker's job doesn't parallelize by adding instances, it parallelizes by claim batch size, already built in) | Same — batch size may need tuning based on real observed tick duration (Section 6) | No — still no evidence of a need `FOR UPDATE SKIP LOCKED` doesn't already handle | Same instance, may need a size bump | No | No | No |
| 3 | 200-1,000 | Web scales further; **rate limiting (Section 21) must move to a shared store (Redis) at this point** if more than one web instance is genuinely needed for load reasons — this is the actual trigger condition for Redis in this codebase, not queueing | Possibly 2 worker instances if a single worker's sequential batch processing can't keep up with the due-store volume within each tier's cadence window — `FOR UPDATE SKIP LOCKED` already makes this safe (Section 7), it's a capacity add, not an architecture change | **Redis becomes justified here — for rate limiting, not for a job queue** | May need connection-pool tuning; read replica still not obviously justified without a demonstrated read-heavy pattern | Revisit only with real query-latency evidence | Only if a meaningful fraction of monitored stores start actively blocking/rate-limiting the crawler at this volume — no evidence this occurs today | Only if marketing-collection volume genuinely can't fit the existing 5-store-batch/slow-cadence design |
| 4 | 1,000+ | Explicitly out of scope for V1 planning per the brief | — | — | — | — | — | — |

**The architecture evolves by adding capacity within the existing pattern (more instances of the same
two process roles, a Redis instance specifically for rate limiting once horizontal web scaling is
real), not by introducing new architectural categories (no queue, no Kubernetes, no read replica) until
a stage's own evidence — not a hypothetical — demonstrates the need.**

---

## 27. Recommended Infrastructure Stack

One concrete recommendation, per the brief's explicit "do not give ten equally weighted choices"
instruction.

- **Frontend/web hosting**: Next.js `next start` deployed on **Render** (primary recommendation) or
  **Fly.io** (equally valid, slightly more manual configuration) — both verified this sub-phase to
  support first-class always-on services and background workers/cron without a serverless execution-
  time ceiling, at flat, predictable, low starting cost ($7/mo Render web service; ~$2-10/mo Fly.io
  small machine). **Why not Vercel despite being the idiomatic Next.js host**: Section 6's own analysis
  shows both the manual-analyze SSE endpoint and the scheduler tick are fundamentally long-running-
  process shaped, which fights against a platform whose core value proposition is short-lived function
  execution — Vercel remains a *reasonable* choice for the web tier alone (SSE responses and moderate
  request durations are fine there) but would force an awkward, defensively-shrunk scheduler design
  (tiny batch size, frequent invocation) to work around its timeout model, when Render/Fly.io need no
  such workaround at comparable or lower cost.
- **PostgreSQL**: **Neon** (primary) or **Supabase** (equally valid) — both verified this sub-phase to
  include managed connection pooling, removing the one real infrastructure piece (PgBouncer) this
  codebase would otherwise need to operate itself.
- **Worker model**: Option B (Section 4/6) — the *same* Next.js codebase, deployed a second time as a
  small always-on Node process whose entrypoint calls the existing `runSchedulerTick`/
  `runMarketingSchedulerTick` functions directly on an interval. Zero new code required beyond a thin
  entrypoint script (a Phase A/B implementation task, not performed in this research sub-phase).
- **Queue**: **none.** `FOR UPDATE SKIP LOCKED` is sufficient (Section 7) and will remain sufficient
  well into Stage 3 (Section 26).
- **Secrets**: platform environment variables (Section 13) — no dedicated secrets manager for V1.
- **Logging**: structured JSON to stdout (captured by whatever the host's own log aggregation provides)
  — no dedicated log-shipping product for V1.
- **Monitoring/Observability**: one error-tracking service (Sentry-class, not specifically chosen this
  sub-phase) for application exceptions; everything else (Section 18) queried directly from existing
  database columns (`Crawl`, `MarketingCollectionRun`, scheduler-tick return values) rather than a
  dedicated metrics product.
- **Deployment**: git-push-to-deploy from whichever host is chosen (both Render and Fly.io support this
  natively) — no custom CI/CD pipeline needed for V1 beyond what the host provides out of the box.
- **Domain**: a real, purchased domain, DNS pointed at the chosen host, HTTPS auto-provisioned by the
  host (Section 15) — not performed this sub-phase.
- **Staging**: a second, smaller deployment of the identical two-process architecture, against a
  separate Neon/Supabase project, with test-tier vendor credentials (Section 16).
- **Production**: the full two-process architecture, real domain, real OAuth, real (initially low-tier)
  SerpApi plan, real `AUTH_SECRET`/`SCHEDULER_SECRET`.

**Guiding principle honored**: this stack introduces exactly two new operational pieces beyond what
exists today (a hosting account, a managed Postgres account) and zero new architectural categories
(no queue, no cache layer, no container orchestrator) — the simplest configuration this document could
construct that is still genuinely reliable for Bellwether's real, current, code-verified workload.

---

## 28. Implementation Roadmap

Staged per the brief's exact phase letters — **describing what each future phase needs to build, not
building any of it now**:

**PHASE A — Infrastructure preparation**: choose and provision the host (Render/Fly.io) and Postgres
provider (Neon/Supabase) accounts; write the thin worker entrypoint script (calling existing scheduler
functions — no new business logic); add `.env.example`/documentation for `SCHEDULER_SECRET` (Section 13's
found gap); decide and document the migration-rollback/backup story (Section 17's found gap); implement
the stale-`RUNNING`-crawl sweep (Section 7's found gap) and a response-size cap on crawler fetches
(Section 11's found gap) — both small, additive, already-scoped fixes.

**PHASE B — Staging environment**: deploy both process roles to the chosen host against a real
(non-production) Postgres; wire real `prisma migrate deploy` into the deployment process; confirm the
scheduler actually fires on cadence against staging data; confirm SSE/manual-analyze works end-to-end
against the real host (not just `next dev`); load-test the database-connection-exhaustion question
flagged in Section 22, scenario 16, with real concurrent traffic before trusting the answer.

**PHASE C — Production deployment**: real domain, real HTTPS, real (initially minimal) OAuth
credentials, real (low-tier) SerpApi plan, first real users. A deliberately small/controlled rollout
(feeds directly into Phase H), not a public launch.

**PHASE D — Real OAuth**: register real Google/Facebook OAuth applications with production callback
URLs (Section 15); this is mostly a manual console-configuration task, not a code change (the code
already supports this — `configuredProviders`).

**PHASE E — Billing**: build the `Subscription` model (Section 23), the billing-provider webhook
handler, the plan-derivation logic — a real schema change and real new code, explicitly out of this
sub-phase's scope.

**PHASE F — Continuous crawling**: turn on the real scheduler cadence against a real, growing corpus of
monitored stores at whatever cadence Section 26's stage the product has actually reached — this is
mostly a "flip it on and watch it" phase given the scheduler already exists and is already tested; the
real value is accumulating the genuine multi-week/multi-month crawl history that Milestone 7 Sub-phase
D's own "known limitation" section flagged as impossible to produce synthetically.

**PHASE G — Observability**: install the chosen error tracker; build the "query existing columns"
dashboards described in Section 18; wire the alerts described in Section 20.

**PHASE H — Controlled beta**: real users beyond the founding team, still capped/invite-gated, watching
Section 20's alerts closely, before any broader release.

---

## 29. Risks

- **The scheduler batch-duration risk (Section 1/6)** is the single largest architectural risk this
  document found — not because the existing design is wrong, but because it was never actually measured
  against real crawl durations at real batch sizes. **Mitigation**: Section 27's host choice sidesteps
  the risk entirely rather than requiring precise tuning; Phase B (staging) should still measure real
  tick durations before Phase C.
- **SerpApi's hard monthly-commitment pricing model (Section 12/25)** creates a real risk of a step-
  function cost jump as the monitored-store count grows, with no pay-as-you-go smoothing. **Mitigation**:
  none proposed here beyond visibility (Section 20's WARNING-tier quota alert) — this is a product/
  business decision (which tier to commit to, how conservatively to set marketing-collection cadence)
  more than an architecture one.
  it.
- **The crawler response-size gap (Section 11)** and **the stale-`RUNNING`-crawl gap (Section 7)** are
  both small, real, already-scoped fixes — low risk individually, but both should land before Phase C
  (production), not be discovered during it.
- **Rate limiting's single-instance limitation (Section 2/21)** is a real constraint on *when* horizontal
  web scaling becomes safe, not a risk to V1 itself (which needs exactly one web instance).
- **No production load has ever touched this system.** Every duration/timing claim in this document
  (Section 6 especially) is inference from configured constants, not measurement. This is the honest
  limit of what a research-only sub-phase, with no deployed infrastructure, can establish.

---

## 30. Open Questions

- Exact production database-provider choice (Neon vs. Supabase) — both are viable per this sub-phase's
  research; the deciding factor is likely a preference this document cannot resolve (Supabase's bundled
  extra services — auth/storage/realtime — are irrelevant to Bellwether, which already has its own
  auth; Neon's branching model may be more directly useful for a staging-mirrors-production workflow).
- Exact production host choice (Render vs. Fly.io) — similarly both viable; Render's git-push simplicity
  vs. Fly.io's lower always-on compute cost at small scale is a real tradeoff worth a short trial of
  each before committing, not a decision this document can make unilaterally.
- Whether Prisma's default connection-pool sizing is actually adequate for the two-process architecture
  at real scale (Section 8/22) — genuinely unknown without a real load test.
- Which error-tracking/observability vendor (Section 18/27) — not evaluated in depth this sub-phase,
  deliberately deferred as a Phase G decision once real production traffic exists to size the choice
  against.
- Whether SerpApi's 401/rate-limit responses are actually classified as gracefully as scenario 9/10
  (Section 22) assumes — worth a direct code re-read or a real test against the live vendor before
  relying on it, not verified to that level of certainty this sub-phase.
- The real HOT/WARM/COOL/COLD tier distribution once real users exist — every storage/cost estimate in
  this document (Sections 9/25) is sensitive to this unknown and should be revisited with real data as
  soon as it exists.

---

## 31. Decision Gate

| Decision | Verdict | Confidence |
|---|---|---|
| Can the current scheduler architecture safely support production? | **Yes**, with the small stale-crawl-sweep addition (Section 7) and a host choice that avoids serverless timeout pressure (Section 27) | High — the concurrency mechanism itself is already integration-tested |
| Does the current crawler require a major architectural rewrite? | **No** — every named production scenario (Section 11) is already handled except one uncapped-response-size gap, itself a small addition, not a rewrite | High |
| Can the current database schema support expected V1 history? | **Yes** — Section 9's growth estimates, even pessimistically, fit comfortably inside any managed Postgres provider's smallest paid tier | Medium (estimates, not measurements) |
| Was a critical security problem discovered? | **No** | High |
| Does production require an unanticipated schema change? | **No** — the one anticipated future schema change (a `Subscription` model, Section 23) was already anticipated by this document, not "unanticipated," and is explicitly deferred, not required for V1 launch itself |
| Is the current authentication architecture compatible with production? | **Yes** — JWT sessions, no DB dependency for session validation, already horizontally-scaling-friendly | High |
| Can the current entitlement model support future billing? | **Yes** — `User.plan` is sufficient as the read side; the write side needs one new additive table, not a rework (Section 23) | High |
| Does any vendor dependency create an unacceptable production risk? | **No** — SerpApi's cost-scaling risk (Section 25/29) is real but manageable, not unacceptable; the report already degrades gracefully around it | Medium |

**No STOP condition (brief Section 26) was triggered.**

---

## 32. Final Recommendation

Deploy Bellwether as **Option B**: the existing Next.js codebase, unmodified in its core logic, run as
two long-lived process roles (web, worker) on **Render or Fly.io**, against a **Neon or Supabase**
managed Postgres, with **no queue, no Redis, no container orchestrator**. Before Phase C (production),
close the three small, already-scoped gaps this research surfaced: a stale-`RUNNING`-crawl sweep
(Section 7), a crawler response-size cap (Section 11), and documenting `SCHEDULER_SECRET`/a migration-
rollback story (Sections 13/17) — none of these require new architecture, only small, additive code
matching patterns the codebase already uses elsewhere.

This is not a scaled-down version of a "real" architecture — it *is* the architecture, sized honestly to
a product that has real code discipline, zero production traffic, and no evidence yet of needing
anything more sophisticated than "two processes, one database, no queue." Every more elaborate option
this document evaluated (Redis, a message queue, Kubernetes, a dedicated secrets manager) was rejected
not because it wouldn't work, but because nothing in this codebase's actual, verified current shape
justifies its operational cost today — exactly the standard the brief itself set.
