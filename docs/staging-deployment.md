# Staging Deployment

Two host options are prepared, both consuming the **same** CI-built GHCR image:

- **Render + Neon** — managed PaaS, `render.yaml`. Sections "Target
  architecture" through "Post-deploy verification" below.
- **Self-hosted VPS (Contabo)** — `docker compose` on a plain Linux box,
  `deploy/contabo-deploy.sh`. See "Deploying to a self-hosted VPS (Contabo)"
  below.

Originated in Milestone 8 Sub-phase B, updated in Sub-phase C, and again in B4
(Dockerfile + `docker-compose.yml` + `/api/health` + `.github/workflows/ci.yml`
+ `render.yaml` converted to `runtime: image`; the Contabo path added after).
Status of this document: **configuration prepared, not yet applied.** No Render or Neon
account/credentials exist in this development environment, so the actual
cloud deployment described below remains **BLOCKED** — it has not been
executed and this document does not claim otherwise. B4's containerization was
verified locally end-to-end (see "Build & image" below): the image builds, the
`web` role migrates-then-serves with `/api/health` green, the `worker` role
runs a full scheduler cycle, and `docker compose up` brings the whole stack up
from an empty database. Every
verification that does not require real cloud infrastructure (real Postgres
via a disposable local instance, real Shopify crawls, real scheduler ticks,
the real worker process, a **real production build run via `next start`**,
real browser sessions) was completed instead — see
`docs/milestone-8-subphase-b-completion-report.md` and
`docs/milestone-8-subphase-c-production-readiness.md` for what was actually
run.

**Critical fix from Sub-phase C — read this before deploying**: running the
app in genuine production mode (`NODE_ENV=production`, `next start`) locally
— something no earlier sub-phase had done, since all prior browser
verification used `next dev` — revealed that Auth.js throws `UntrustedHost`
for every single authentication request (session, CSRF, sign-in, sign-up)
unless `AUTH_TRUST_HOST=true` is set. `next dev` masks this completely
because Auth.js auto-trusts the host whenever `NODE_ENV !== "production"`.
Without this variable, login would have been **completely broken** on Render
(or any non-Vercel host) despite every previous browser test passing. This is
now fixed (`AUTH_TRUST_HOST=true` added to `render.yaml`'s web service, and
to `.env.example`/`docs/environment-variables.md`) and re-verified with a
real `next start` + real browser session — see the production-readiness
report's Section 9/19.

## Target architecture

```
INTERNET
   |
   v
Render Web Service (store-spy-web)  --- Neon Postgres (managed, pooled)
   the image, ENTRYPOINT role `web`        ^
   (migrate deploy -> node server.js)      |
Render Worker Service (store-spy-worker) -
   the SAME image, role `worker`
```

Two Render services, one Neon database. No queue, no Redis, no separate
analytics database — the same architecture already running locally, deployed
twice (web, worker) against one real managed Postgres instead of the
disposable local one used for development/testing. See
`docs/milestone-8-subphase-a-production-architecture-research.md` Section 27
for why this pairing (Render + Neon) was chosen over the equally-valid
Fly.io/Supabase alternative — this document commits to one concrete
combination rather than leaving both open.

## Build & image (B4)

**Nothing is built on the deploy host.** `.github/workflows/ci.yml` runs the
full test gate (lint, typecheck, unit, integration against a Postgres service)
and, on a push to `main` or a `v*` tag, builds the image from the repo-root
`Dockerfile` and pushes it to **GHCR** as
`ghcr.io/<owner>/<repo>:latest` (plus `:sha-…` and, for tags,
`:<version>`). Render pulls that image; `render.yaml`'s two services are
`runtime: image` pointing at the same tag.

One image, two roles, selected by the container command (`docker-entrypoint.sh`):

| role | command | does |
|---|---|---|
| `web` (default `CMD`) | — | `prisma migrate deploy`, then `node server.js` (Next standalone) |
| `worker` | `dockerCommand: worker` in `render.yaml` | the scheduler cycle; **never** migrates |

Because the `web` entrypoint applies migrations before `node server.js`, and
`healthCheckPath: /api/health` only goes green once that server answers, Render
never routes traffic before the schema is current — so there is **no
`preDeployCommand`** any more. The same entrypoint runs identically under
`docker compose` and a bare `docker run`.

Before the first deploy:

1. **Set the real image path.** `render.yaml` ships `ghcr.io/OWNER/REPO:latest`
   as a placeholder — replace `OWNER/REPO` with the actual GitHub path once the
   repo is (re)named (`Store Spy` rebrand, still pending).
2. **Add a GHCR registry credential in Render** (Settings → Registry
   Credentials) — GHCR packages are private by default. Use a GitHub PAT with
   `read:packages`, or make the package public.
3. **Redeploy on a new image.** Enable Render's image auto-deploy on `:latest`,
   or call a Render deploy hook from CI after the push step.

For a local production-parity run of the whole stack (Postgres + web + worker
from the built image): `cp .env.example .env`, fill in values, then
`docker compose up --build` (see `docker-compose.yml`; distinct from
`docker-compose.test.yml`, which is Postgres-only for the integration suite).

## Deploying to a self-hosted VPS (Contabo)

Same GHCR image as the Render path, run with `docker compose` on a plain Linux
host. Files:

| file | role |
|---|---|
| `docker-compose.yml` | the stack (Postgres + web + worker), shared with local runs |
| `docker-compose.prod.yml` | override: drops `build:`, sets `image: ${IMAGE}:${IMAGE_TAG}` + `pull_policy: always` + `restart: unless-stopped`. Needs Docker Compose >= 2.24 for the `!reset` tag |
| `deploy/contabo-deploy.sh` | `docker login ghcr.io` -> `pull` -> `up -d` -> `/api/health` gate (rollback on fail) -> image prune |
| `deploy/deploy.env.example` | template for `deploy/deploy.env` (GHCR PAT, `IMAGE`, `KEEP_IMAGES`, ...) — the real file is gitignored |

### One-time host setup

```sh
# On the VPS:
git clone <repo> && cd <repo>
cp .env.example .env                                   # real app secrets — edit
cp deploy/deploy.env.example deploy/deploy.env
chmod 600 deploy/deploy.env                            # holds a real token
$EDITOR deploy/deploy.env                              # GHCR_USER, GHCR_TOKEN, IMAGE
```

- **`GHCR_TOKEN`** is a GitHub PAT with **only** `read:packages` (classic) or a
  fine-grained token with "Packages: read". Not a password. This is the
  self-hosted equivalent of adding a Registry Credential in the Render
  dashboard — GHCR packages are private by default, so the host cannot pull
  without it. The deploy script pipes it to `docker login ghcr.io` via
  `--password-stdin` (never on the command line).
- **`IMAGE`** is `ghcr.io/<owner>/<repo>` with no tag, matching what CI pushes
  (`ghcr.io/${{ github.repository }}`). `IMAGE_TAG` defaults to `latest`.
- The host still needs a normal `.env` (the base compose file's
  `env_file: .env`). If you use managed Postgres instead of the in-stack one,
  see the comment block at the bottom of `docker-compose.prod.yml`.
- Put a TLS-terminating reverse proxy (Caddy / nginx / Traefik) in front of
  `WEB_PORT`; only the web service needs to be reachable, and the worker has no
  HTTP surface at all.

### Deploy / redeploy / roll back

```sh
./deploy/contabo-deploy.sh                    # deploy IMAGE_TAG (default: latest)
IMAGE_TAG=sha-abc1234 ./deploy/contabo-deploy.sh   # pin, or roll back, to a build
```

The script: logs in to GHCR; records the currently-deployed image id;
`docker compose ... pull` then `up -d`; polls `http://localhost:${WEB_PORT}/api/health`
for up to 5 min. Because the `web` entrypoint runs `prisma migrate deploy`
before it serves, a green `/api/health` also means the schema is current — so,
as on Render, there is no separate migration step. **On health-check failure**
it re-tags the previous image and `up -d`s again (rollback), dumps the last 60
lines of `web` logs, and exits non-zero.

CI still builds and pushes on every push to `main` / `v*` tag; this script is
what you run on the host afterwards (by hand, or from a deploy hook / cron /
`ssh` step). Nothing is built on the VPS.

### Image pruning on the host

The image is ~1.2 GB per version. On Contabo's 75 GB disk, unbounded pulls
would fill the host in a few dozen deploys (Postgres's volume and logs grow
into the same 75 GB). After a **successful** rollout the script keeps the
`KEEP_IMAGES` (default 3: current + two rollback targets) most-recent versions
of the repo and `docker rmi`s the older ones, then `docker image prune -f`
clears the now-dangling layers from the previous `:latest`. Pruning is
deliberately last — a failed deploy keeps every prior image so the rollback
path has something to re-tag.

Check headroom any time with `docker system df`. A manual sweep, if a deploy
was interrupted before its prune: `docker image prune -f && docker builder prune -f`
(the host never builds, so `builder prune` is normally a no-op).

## Prerequisites (manual, human-performed — not automatable from this repo)

1. A Render account, with billing configured (`starter` plan tier, ~$7/mo per
   service — two services, web + worker).
2. A Neon account, with a new **staging** project created — a project
   entirely separate from whatever project (if any) hosts production later.
   Never share a database between staging and production
   (`docs/environment-variables.md`'s "never shared between environments"
   list).
3. A generated `AUTH_SECRET` for staging: `openssl rand -base64 32`. Must be a
   different value than local development uses and different again from
   whatever production eventually uses.
4. A generated `SCHEDULER_SECRET` for staging, same command, if the HTTP
   scheduler routes will ever be manually triggered in staging (the worker
   itself does not need this — see `render.yaml`'s comment on the point).
5. Optional: a staging-tier `SERPAPI_API_KEY`, separate from any local key, if
   marketing-collection verification against staging is desired. Real SerpApi
   calls are billed — see `docs/environment-variables.md`.
6. Optional: OAuth app credentials (Google/Facebook) registered with
   staging's actual callback URL, if OAuth sign-in needs verification in
   staging. Without these, the app runs fine — the Credentials (email/
   password) provider needs no OAuth configuration at all.

## Deployment steps (to be performed once the above exist)

1. **Create the Neon project.** Copy its pooled connection string (Neon's
   dashboard distinguishes a "pooled" and "direct" connection string — use
   the **pooled** one for `DATABASE_URL`, matching the reasoning in
   `docs/milestone-8-subphase-a-production-architecture-research.md`
   Section 27 for choosing a provider with bundled pooling).
2. **Connect this repository to Render** as a Blueprint (`render.yaml` at the
   repo root, already committed — Render detects it automatically when
   creating a new Blueprint instance from this repo). Do the "Build & image"
   prerequisites above first (real `ghcr.io/tanjiljishad/store-spy:latest`
3. **Set the real env var values** for both services in the Render dashboard
   (never in `render.yaml` — every variable there is `sync: false`
   deliberately). Use the checklist below.
4. **Deploy.** The web image's ENTRYPOINT runs `prisma migrate deploy` on
   startup, applying all existing migrations to the new, empty Neon database
   automatically — no manual migration step, no `preDeployCommand`. Confirm via
   Render's log that it reports `All migrations have been successfully applied.`
   and then `[entrypoint] starting web server` before the health check goes
   green. **If the target database is NOT empty, read "Database migrations"
   below first.**
5. **Verify both services are alive**: the web service's health check
   (`healthCheckPath: /api/health` — `200 {"status":"ok","db":"ok"}`) should go
   green; the worker service has no HTTP surface — confirm via its logs showing
   a `worker.starting` line followed by periodic `worker.cycle_completed` lines
   (see `scripts/worker.ts`'s structured logging).
6. **Do not seed fake data.** Per this sub-phase's own instruction, the
   staging corpus must be generated through the real application pipeline —
   sign up a real (test) account, analyze a small number of real public
   Shopify stores through the actual UI, exactly as
   `docs/milestone-8-subphase-b-completion-report.md`'s local verification
   already did against the disposable Postgres instance.

## Database migrations

### `DATABASE_URL` form

Since the control-plane split (migration `20260828120000_control_plane_and_schema_split`)
the application's tables live in the `store_spy` schema and the shared
identity/billing layer in `control_plane`; `_prisma_migrations` stays in
`public`. `DATABASE_URL` **must** carry
`?options=-c%20search_path%3Dstore_spy%2Cpublic` and **must not** carry
`?schema=`. The web service refuses to start otherwise (`src/instrumentation.ts`),
and the full rationale is in `docs/environment-variables.md`. Append the
`options` parameter to Neon's pooled connection string before pasting it into
Render.

### First deploy to an empty database (the normal case)

Nothing special. `prisma migrate deploy` runs the whole migration chain from
scratch: migrations up to `20260824000000` create every table in `public`,
then `20260828120000` moves them into `store_spy` and creates `control_plane`.
Verified end to end against a fresh database. Confirm the deploy log ends with
`All migrations have been successfully applied.`

### Deploy to a database that already has migration history

`prisma migrate deploy` applies only the pending migration(s) and does **not**
re-run or re-check already-recorded ones, so deploying `20260828120000` onto a
database that already has migrations 1–N recorded works the same as any other
incremental migration — this was tested explicitly (22 prior migrations
recorded in `public._prisma_migrations`, `20260828120000` deployed cleanly on
top with both the old and the new `DATABASE_URL` form).

### If `prisma migrate deploy` reports `P3005 — The database schema is not empty`

This means Prisma found database objects it cannot account for from
`_prisma_migrations` — e.g. a schema/table created outside Prisma, an
interrupted migration, or (the way it was hit once during B1 development) a
`prisma migrate diff --shadow-database-url` accidentally pointed at a real
database, which partially applies migration 1 before failing and leaves stray
types behind. It is a drift/baseline condition, not something the normal
deploy path produces.

Recovery, for the specific pending migration `<NAME>` (do this against the
target database, with the same `DATABASE_URL`):

```
# 1. See what Prisma thinks is applied vs pending.
npx prisma migrate status

# 2. If <NAME> is pending and its objects are genuinely absent, apply its SQL
#    directly, then record it as applied so `migrate deploy` moves on:
npx prisma db execute --schema prisma/schema.prisma \
  --file prisma/migrations/<NAME>/migration.sql
npx prisma migrate resolve --applied <NAME>

# 3. If <NAME>'s objects ARE already present (a previous run got partway),
#    just record it as applied — do NOT re-run the SQL:
npx prisma migrate resolve --applied <NAME>

# 4. Confirm.
npx prisma migrate deploy      # -> "No pending migrations to apply."
npx prisma migrate status
```

Then remove whatever stray objects caused the drift (for the shadow-db case:
`DROP SCHEMA store_spy CASCADE; DROP SCHEMA control_plane CASCADE;` on the
polluted database *before* step 2, if they were only partially created).

Never run `prisma migrate reset` against a database with real data — it drops
and recreates everything.

## Environment variable checklist (staging values)

See `docs/environment-variables.md` for the full reference (what each
variable protects, generation method). Staging-specific notes only:

| Variable | Web service | Worker service | Staging value source |
|---|---|---|---|
| `DATABASE_URL` | Required | Required | Neon staging project's **pooled** connection string, with `?options=-c%20search_path%3Dstore_spy%2Cpublic` appended and no `?schema=` — see "Database migrations" above; the web service refuses to start if this is wrong |
| `AUTH_SECRET` | Required | **Not needed** — verified in Sub-phase C that the worker's import chain never touches `next-auth`/`@auth/core`, and a real worker run with `AUTH_SECRET` unset completed a full cycle with no error | Freshly generated, staging-only |
| `AUTH_TRUST_HOST` | **Required** — see the critical-fix note above; without it every Auth.js endpoint fails closed | Not needed (same reasoning as `AUTH_SECRET`) | `"true"` |
| `SCHEDULER_SECRET` | Required if the HTTP scheduler routes will be manually triggered | Not needed (worker calls scheduler functions directly) | Freshly generated, staging-only, if used |
| `SERPAPI_API_KEY` | Not read by the web process | Optional — only if marketing-tick verification against staging is desired | A separate, low-tier key from any production key |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Optional | Not read by the worker | Staging-registered OAuth app, staging callback URL |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | Optional | Not read by the worker | Same as Google |
| `NODE_ENV` | Set automatically (`render.yaml`) | Set automatically (`render.yaml`) | `production` (Render's own convention for any non-local deploy, staging included — there is no separate "staging" NODE_ENV value in this codebase) |

Never commit any of the real values above. `render.yaml` intentionally
contains no secrets — every entry is `sync: false`.

## What Sub-phase C already verified locally (real infra, not just tests)

Confirm parity with these once actually deployed, rather than re-discovering them from scratch:

- Real production build (`next build && next start`, `NODE_ENV=production`) — the `AUTH_TRUST_HOST`
  bug above was found exactly this way.
- Real worker run against real (local, disposable) Postgres: a single-store tick, a 4-store mixed
  batch (3 real Shopify crawls + 1 deliberately unreachable domain, `claimed:4, succeeded:3, failed:1`),
  a worker crash+restart with no duplicate work.
- Real SerpApi calls: two samples — one cold query took ~237s, a second (likely vendor-cached)
  query for the same domain took ~0.4s. Treat SerpApi latency as **highly variable**, not a fixed
  number, when sizing worker tick intervals or timeouts.
- Real browser journey (anonymous → analyze → signup → dashboard → full report → Store
  Intelligence → logout), desktop + mobile, zero console errors, against the real production build.
- Full anonymous/entitlement/watchlist authorization boundaries code-reviewed and confirmed
  user-scoped (no cross-user data access).

## Post-deploy verification checklist (to run once actually deployed)

This is the list Sub-phase C (or whoever next has real Render/Neon
credentials) should work through — mirroring the local verification already
completed this sub-phase, but against the real hosted infrastructure:

- [ ] Web service responds at its Render-assigned URL; landing page renders.
- [ ] Sign up a real test account; full analyze → SSE → report flow works
      end-to-end against the real Neon database.
- [ ] Worker service logs show `worker.starting` on boot and
      `worker.cycle_completed` on the expected ~5-minute cadence.
- [ ] Manually seed one due store (or wait for the natural cadence) and
      confirm the worker's `scheduler.tick_completed` log shows a real claim
      and a real crawl against the live database.
- [ ] Confirm `prisma migrate status` (or the Render deploy log) shows zero
      pending migrations after the first deploy.
- [ ] Restart the worker service from the Render dashboard; confirm no
      permanently-stuck `RUNNING` crawl rows and normal resumption (mirrors
      the local restart test in the completion report, now against Render's
      actual process-lifecycle/restart behavior rather than this local
      Windows environment's limitations).
- [ ] Confirm response times, tick durations, and crawl durations under real
      network conditions (Render-to-Neon latency, Render-to-Shopify latency)
      — expect these to differ from local-embedded-Postgres measurements.
- [ ] Confirm `SCHEDULER_SECRET`-protected routes correctly reject requests
      without the header and accept requests with it, if those routes are
      exercised in staging at all.
