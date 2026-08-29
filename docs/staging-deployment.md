# Staging Deployment

Two host options are prepared, both consuming the **same** CI-built GHCR image:

- **Self-hosted VPS (Contabo) — the authoritative deploy path.** `docker
  compose` on a plain Linux box, `docker-compose.prod.yml` +
  `deploy/contabo-deploy.sh`. See "Deploying to a self-hosted VPS (Contabo)"
  and "Host hardening" below.
- **Render + Neon — fallback.** Managed PaaS, `render.yaml`, pulling the same
  image. Sections "Target architecture" through "Post-deploy verification"
  below. Kept working, but the Contabo path is what the deploy config,
  `docker-compose.prod.yml` comments, and `src/lib/security/rate-limit.ts`'s
  proxy-hop assumptions are written against.

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
  `env_file: .env`) — see "Environment variable checklist" below for every
  variable it must contain. `.env` must also set **`POSTGRES_PASSWORD`** (no
  default; `docker compose` and the deploy script both abort without it) and,
  for the web service, **`TRUSTED_PROXY_HOPS`** (no default; the web container
  refuses to boot without it — see "Host hardening"). If you use managed
  Postgres instead of the in-stack one, see the comment block at the bottom of
  `docker-compose.prod.yml`.
- A TLS-terminating reverse proxy (Caddy / nginx) in front of the web
  container is **mandatory**, not optional, and it must be configured
  precisely — see "Host hardening" immediately below. The worker has no HTTP
  surface at all.

### Host hardening

`docker-compose.prod.yml` publishes **no** host port for Postgres, and the web
container's port is bound to `127.0.0.1` only. Nothing in the stack is reachable
from outside the host except through the reverse proxy you put in front of it.
The three things below are load-bearing; a deploy that skips any of them is not
safe to expose.

**1. Host firewall.** Allow inbound `22` (SSH), `80`, and `443` only. Note that
Docker inserts its own `iptables` rules that **bypass `ufw`** — publishing a
container port to `0.0.0.0` would be reachable from the internet even with `ufw`
"deny incoming". The compose files already avoid that (loopback binds +
`ports: !reset []` for Postgres), so with a normal host firewall the only
externally reachable thing is your proxy. Do **not** add `-p 0.0.0.0:...`
mappings or a `DOCKER-USER` allow rule that re-exposes them.

**2. `TRUSTED_PROXY_HOPS`.** Set it in `.env` for the web service. It has **no
default** — the web container throws at startup (`src/instrumentation.ts`) if it
is unset or invalid, because a wrong value silently re-opens `x-forwarded-for`
spoofing for every IP-keyed rate limit (signup, login throttle, `/api/analyze`,
the anonymous quota). For the topology here — exactly one reverse proxy
(Caddy/nginx) directly in front of the web container — the value is **`1`**. Add
a CDN in front of that proxy and it becomes `2`. See
`docs/environment-variables.md` and `src/lib/security/rate-limit.ts`.

**3. Reverse proxy config.** The proxy must (a) set `X-Forwarded-For` so the
one appended entry is the real client (which is what `TRUSTED_PROXY_HOPS=1`
then trusts), and (b) refuse `/api/internal/*` from the public — those routes
(`/api/internal/entitlements`, `/api/internal/scheduler/*`,
`/api/internal/debug/*`) are secret-gated and fail closed, but they are for
in-host / operator use only and have no reason to be internet-reachable.

Caddy (`/etc/caddy/Caddyfile`):

```
app.example.com {
    # Block operator-only routes outright (404, no hint they exist).
    @internal path /api/internal/*
    respond @internal 404

    # Caddy sets X-Forwarded-For to the immediate client and appends to any
    # existing value by default, so the rightmost entry is the real client —
    # exactly what TRUSTED_PROXY_HOPS=1 reads. Do not add trusted_proxies /
    # X-Forwarded-For rewrites that would change that.
    reverse_proxy 127.0.0.1:3000
}
```

nginx (`server` block):

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;
    # ... ssl_certificate / ssl_certificate_key ...

    # Operator-only routes: not reachable from the internet.
    location /api/internal/ { return 404; }

    location / {
        proxy_pass http://127.0.0.1:3000;
        # $proxy_add_x_forwarded_for = "<existing XFF>, <nginx's $remote_addr>".
        # With one nginx hop, the rightmost entry is the real client, which is
        # what TRUSTED_PROXY_HOPS=1 trusts. Do NOT use a bare
        # "proxy_set_header X-Forwarded-For $remote_addr" or trust a
        # client-sent X-Real-IP.
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

If you front the proxy with Cloudflare or another CDN (so there are two hops),
set `TRUSTED_PROXY_HOPS=2` and make sure both hops append rather than rewrite
`X-Forwarded-For`.

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

## Environment variable checklist

`docs/environment-variables.md` is the full reference — what each variable
protects, how to generate a value, and the authoritative per-process matrix.
This is the deploy-time checklist: **every** variable the code reads, whether
it is required, and where it goes. On Contabo these all live in the host's
`.env` (plus `POSTGRES_PASSWORD`); on Render they are per-service dashboard
values (`render.yaml` carries none — every entry is `sync: false`).

"Fail-closed" below means the feature refuses to operate when the variable is
unset — it never silently degrades to an unprotected state. "Boot-fails" means
the **web container will not start** without it.

| Variable | Web | Worker | Required? | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | ✅ | ✅ | **Yes** | Managed-Postgres (or in-stack) connection string with `?options=-c%20search_path%3Dstore_spy%2Cpublic` and **no** `?schema=`. Web **boot-fails** on a wrong `search_path` (`src/instrumentation.ts`). |
| `POSTGRES_PASSWORD` | — | — | **Yes, if using the in-stack Postgres** (Contabo default) | Compose-only — the in-stack DB password and the password in the compose `DATABASE_URL`. **No default**; `docker compose` and `deploy/contabo-deploy.sh` both abort if unset. `openssl rand -base64 24`. Not needed on Render (managed DB). |
| `TRUSTED_PROXY_HOPS` | ✅ | — | **Yes** | **No default; web boot-fails without it.** Number of trusted reverse-proxy hops. `1` for the Contabo topology (one Caddy/nginx), `2` with a CDN in front, `0` only if nothing proxies the process. See "Host hardening". |
| `AUTH_SECRET` | ✅ | — | **Yes** | `openssl rand -base64 32`, unique per environment. Worker's import chain never touches Auth.js — verified unset-safe there. |
| `AUTH_TRUST_HOST` | ✅ | — | **Yes** (non-Vercel host) | `"true"`. Without it every Auth.js endpoint fails closed with `UntrustedHost`. |
| `CONTROL_PLANE_INTERNAL_SECRET` | ✅ | — | **Yes** | Gates `GET /api/internal/entitlements` (constant-time compare). **Fail-closed** (503) if unset. `openssl rand -base64 32`. |
| `SCHEDULER_SECRET` | ✅ | — | **Yes** in practice | Gates `POST /api/internal/scheduler/{tick,marketing-tick}` and `/api/internal/debug/headers`. **Fail-closed** (503 / 404) if unset. The worker ticks in-process and does not need it, but any operator/monitor trigger does. `openssl rand -base64 32`. |
| `TURNSTILE_SECRET_KEY` | ✅ | — | **Yes** (for anonymous analysis) | Server-side Turnstile verification for anonymous `POST /api/analyze`. **Fail-closed**: unset ⇒ every anonymous request rejected (never skipped). |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | ✅ (build-time) | — | **Yes** (for anonymous analysis) | Public site key, same Turnstile site as the secret. Inlined at image-build time — must be present when CI builds the image, not just at runtime. Unset ⇒ the widget doesn't render and anonymous analysis is unusable (server check still fails closed). |
| `EMAIL_VERIFICATION_TOKEN_SECRET` | ✅ | — | **Yes** | Signs `GET /verify-email` links. **Fail-closed**: unset ⇒ no verification link can be minted **and** none verifies, so every account is stuck at `/verify-email`. `openssl rand -base64 32`, dedicated (never reuse `AUTH_SECRET`). |
| `UNSUBSCRIBE_TOKEN_SECRET` | ✅ | — | **Yes** | Signs `GET /unsubscribe` links. **Fail-closed**. `openssl rand -base64 32`, dedicated. |
| `RESEND_API_KEY` | ✅ | — | **Yes** (for any outbound email) | Resend API key. Without it (or `EMAIL_FROM`) email never sends — signup/resend catch it (non-fatal / 502), so no crash, but verification email is dead. |
| `EMAIL_FROM` | ✅ | — | **Yes** (alongside `RESEND_API_KEY`) | Verified sending-domain address. An unverified From domain gets every send rejected by Resend. |
| `ANONYMOUS_CRAWL_HOURLY_CEILING` | ✅ | — | Optional (default 500) | Global circuit breaker for anonymous analysis across all IPs/hour. Tune under real traffic. |
| `SERPAPI_API_KEY` | — | ✅ | Optional (required for marketing collection) | Read only by the worker. Without it the marketing tick logs `SERPAPI_API_KEY is not configured` each cycle and every other feature is unaffected. Billed — use a separate low-tier key from production. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | ✅ | — | Optional | Google sign-in button; absent ⇒ button not rendered. Needs a real OAuth app with this host's callback URL. |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | ✅ | — | Optional | Same as Google. |
| `NODE_ENV` | ✅ | ✅ | Platform-managed | `production` on any non-local deploy. Set by the image / `render.yaml`. |
| Marketing pixel / conversion vars (`NEXT_PUBLIC_*_PIXEL_*`, `*_CONVERSIONS_API_ACCESS_TOKEN`, `GOOGLE_MEASUREMENT_PROTOCOL_API_SECRET`, `X_PIXEL_ID`) | ✅ (client IDs, build-time) / worker (server tokens) | | Optional, **off by default** | Leave unset. The server-side conversion tokens are a PROVIDER SEAM — Milestone 12 §4.3 (credential vault) hasn't shipped, so a real value has nowhere safe to live. Full per-var detail in `docs/environment-variables.md`. |

Never commit any real value. On Contabo, `.env` and `deploy/deploy.env` are
gitignored; on Render every `render.yaml` entry is `sync: false`.

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
