# syntax=docker/dockerfile:1

# ── base ──────────────────────────────────────────────────────────────────────
# glibc (bookworm) not alpine: Prisma's engine binaries are less fussy on glibc,
# and this image is small enough that musl buys nothing worth the friction.
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# openssl in EVERY stage, not just the runner: `prisma generate` sniffs the
# installed libssl to pick an engine binaryTarget. Without it here the build
# stage guesses `debian-openssl-1.1.x` and the runtime (which has 3.0) then
# can't find its engine. ca-certificates: outbound HTTPS at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ── deps ──────────────────────────────────────────────────────────────────────
# Full install (incl. dev) for the build. Its own layer so it only re-runs when
# package.json / package-lock.json change.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── prod-deps ─────────────────────────────────────────────────────────────────
# The runtime dependency set: everything the web server and the worker import,
# plus the `prisma` CLI (migrate deploy) and `tsx` (runs scripts/worker.ts) —
# both moved to `dependencies` for exactly this reason. No dev tooling.
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npx prisma generate
RUN npm run build

# ── runner ────────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Runtime deps first…
COPY --from=prod-deps /app/node_modules ./node_modules
# …then the generated Prisma client + engines from the build stage (which ran
# `prisma generate` against the real schema). `node`-owned so the `prisma` CLI
# can touch its own checksum/lock files at `migrate deploy` time without
# root — the alternative is it trying to re-download an engine at startup.
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=node:node /app/node_modules/prisma ./node_modules/prisma

# The standalone server bundle + its assets. (No `public/` in this repo — add
# `COPY --from=build /app/public ./public` here if one is ever introduced.)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# Needed at runtime, not part of the Next build trace:
#   prisma/       — schema + migrations for `prisma migrate deploy`
#   scripts/      — the worker entrypoint
#   src/          — the worker runs scripts/worker.ts with tsx, which walks the
#                   real .ts source (src/lib/** — all relative imports, no `@/`
#                   alias, so no tsconfig paths resolution needed); the build
#                   stage already stripped __tests__ via .dockerignore
#   tsconfig.json — pins tsx's compiler options deterministically
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
# Files stay root-owned and world-readable; nothing writes to /app at runtime
# (no ISR — every route is dynamic or build-time-static), so `node` only needs
# read/execute, which COPY's default 0644/0755 already grants.
USER node
EXPOSE 3000

# `web` (default) → migrate deploy + `node server.js`
# `worker`        → `tsx scripts/worker.ts`, no migrations
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["web"]
