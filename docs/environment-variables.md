# Environment Variables Reference

Evergreen reference — update this file whenever a new environment variable is
introduced. See `docs/milestone-8-subphase-a-production-architecture-research.md`
Section 13 for the original audit that found `SCHEDULER_SECRET` undocumented
(now fixed by this file's existence) and `.env.example` / `.env.test.example`
for copy-paste templates.

**Never commit a real secret value.** `.env` and `.env.test` are gitignored;
`.env.example` and `.env.test.example` are committed templates and must only
ever contain placeholders.

| Variable | Required? | Classification | Used by | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | Always | SECRET | Prisma client, everywhere | Postgres connection string. Different value per environment — local/staging/production must never share a database. |
| `AUTH_SECRET` | Always | SECRET | Auth.js (JWT signing), read implicitly by `next-auth` — not referenced directly as `process.env.AUTH_SECRET` in application code | Generate with `openssl rand -base64 32`. Unique per environment — a shared value across environments would let a staging-issued session token authenticate in production. |
| `AUTH_TRUST_HOST` | **Required in staging/production** on any non-Vercel host; not needed locally | Not a secret (`"true"`) | Auth.js core (`@auth/core`'s `setEnvDefaults`), read implicitly, not referenced directly in application code | Auth.js only auto-trusts the incoming request's `Host` header when `NODE_ENV !== "production"` (true for local `next dev`) or when `AUTH_URL`/`VERCEL`/`CF_PAGES` is set. On Render (or Fly.io, or any self-hosted platform) running `next start` with `NODE_ENV=production`, none of those apply, so every Auth.js endpoint (`/api/auth/session`, `/csrf`, `/providers`, sign-in callbacks) fails closed with `UntrustedHost` — reproduced directly in Milestone 8 Sub-phase C by running a real `next start` locally. Set to `"true"`. See https://errors.authjs.dev#untrustedhost. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional | ID: server-only / Secret: SECRET | `src/lib/auth/auth.ts` | App runs fine without them — the Google sign-in button simply doesn't render (`configuredProviders.google`). Real values need a real Google OAuth app with production-domain callback URLs registered (Section 15 of the Sub-phase A research doc). |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | Optional | Same split as Google | `src/lib/auth/auth.ts` | Same optionality as Google. |
| `SERPAPI_API_KEY` | Optional locally, required for marketing collection | SECRET | `src/lib/marketing/source-factory.ts` | Without it, `getConfiguredMarketingSource()` throws — the marketing scheduler tick and `npm run marketing-scheduler:tick` fail loudly rather than silently no-op-ing. Every other feature (Shopify crawling, growth signals, dashboard) works completely unaffected. Real, billed key — see SerpApi's plan tiers before setting a production value; there is no pay-as-you-go, only monthly commitments (Sub-phase A research, Section 12). |
| `SCHEDULER_SECRET` | Optional locally, **required in staging/production** | SECRET | `src/app/api/internal/scheduler/tick/route.ts`, `src/app/api/internal/scheduler/marketing-tick/route.ts` | **What it protects**: both routes trigger a real scheduler tick — real outbound Shopify crawls and, for the marketing route, real billed SerpApi calls. Both fail CLOSED (HTTP 503) if this variable is unset, so an unauthenticated deployment refuses every request rather than silently accepting one. A request must send this exact value in the `x-scheduler-secret` header to succeed. **Which endpoint uses it**: both `/api/internal/scheduler/tick` and `/api/internal/scheduler/marketing-tick`, same value for both. **How the worker relates to it**: the worker process (`scripts/worker.ts`, Milestone 8 Sub-phase B) calls `runSchedulerTick()`/`runMarketingSchedulerTick()` *directly*, in-process — it does **not** go through these HTTP routes at all, so the worker itself needs no `SCHEDULER_SECRET`. These routes remain useful as a manual-trigger/health-check surface for a human operator (or an external monitoring check) to invoke a tick on demand, independent of the worker's own cadence. **Is it required in staging?** Yes, if staging's worker (or a human) will ever hit these HTTP routes — set a real (staging-only) value. Not required if staging exclusively relies on the worker process's direct, in-process ticking and the HTTP routes are never actually called. **How to generate a value**: `openssl rand -base64 32`, same as `AUTH_SECRET`. |
| `NODE_ENV` | Platform-managed | Not a secret | `src/lib/db/prisma.ts` (dev-mode Prisma-client singleton caching) | Set automatically by `next build`/`next start`/most hosts — not something a developer sets by hand locally (`next dev` sets it to `development` itself). |

## Process matrix (which process needs which variable)

Verified directly this sub-phase (Milestone 8 Sub-phase C) by reading every `process.env.*`
reference in `src/` and `scripts/`, and by empirically running the worker with `AUTH_SECRET`
unset (completed a full cycle with no error) — not assumed from variable names.

| Variable | Required | Web | Worker | Build (`prisma generate`/`next build`) | Secret |
|---|---|---|---|---|---|
| `DATABASE_URL` | Always | Yes | Yes | Yes (`prisma generate` needs it resolvable; `migrate deploy` needs it live) | Yes |
| `AUTH_SECRET` | Always | Yes | No | No | Yes |
| `AUTH_TRUST_HOST` | Staging/production only | Yes | No | No | No |
| `SCHEDULER_SECRET` | Optional (only if HTTP scheduler routes are used) | Yes | No | No | Yes |
| `SERPAPI_API_KEY` | Optional (required for marketing collection) | No | Yes | No | Yes |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Optional | Yes | No | No | ID: no / Secret: yes |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | Optional | Yes | No | No | ID: no / Secret: yes |
| `NODE_ENV` | Platform-managed | Yes | Yes | Yes | No |

## Never shared between environments

`AUTH_SECRET`, `DATABASE_URL`, OAuth client credentials (production OAuth apps
need production callback URLs — a shared credential would either break
staging or misconfigure production), `SERPAPI_API_KEY` (a shared key means
local/staging experimentation consumes real, billed production quota),
`SCHEDULER_SECRET`.

## Local / staging / production quick reference

| | Local | Staging | Production |
|---|---|---|---|
| `DATABASE_URL` | Local/embedded/test Postgres | A real, separate managed-Postgres staging database | A real, separate managed-Postgres production database |
| `AUTH_SECRET` | Any local value | Unique, freshly generated | Unique, freshly generated |
| `AUTH_TRUST_HOST` | Unset (`next dev` auto-trusts) | `"true"` | `"true"` |
| `SCHEDULER_SECRET` | Usually unset (use `npm run scheduler:tick` directly instead of the HTTP route) | Set if the HTTP routes will be exercised | Set — required for the worker's manual-trigger surface and any external health check |
| `SERPAPI_API_KEY` | A low-tier/free-plan key, or unset | A separate low-tier key from production | Real, billed production key |
| OAuth credentials | Usually unset (Credentials provider still works) | Test/sandbox app credentials, staging callback URLs | Real, production-registered app credentials |
