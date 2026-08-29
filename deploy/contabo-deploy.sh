#!/usr/bin/env bash
#
# Pull the CI-built image from GHCR and (re)start the stack on a self-hosted
# host — e.g. a Contabo VPS. There is NO build here: CI builds and pushes the
# image (.github/workflows/ci.yml), this only pulls it. See
# docs/staging-deployment.md, "Deploying to a self-hosted VPS (Contabo)".
#
# One-time setup on the host:
#   git clone <repo> && cd <repo>
#   cp .env.example .env                       # real app secrets, then edit
#   cp deploy/deploy.env.example deploy/deploy.env && chmod 600 deploy/deploy.env
#   #   ^ fill in GHCR_USER / GHCR_TOKEN / IMAGE
#
# Deploy:
#   ./deploy/contabo-deploy.sh                 # deploy IMAGE_TAG (default: latest)
#   IMAGE_TAG=sha-abc1234 ./deploy/contabo-deploy.sh   # pin / roll back
#
# Exit status is non-zero if the new image fails its health check (and the
# script rolls the tag back to the previous image before exiting).

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root — the compose files and .env live here

# --- config -----------------------------------------------------------------
ENV_FILE="deploy/deploy.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

: "${GHCR_USER:?set GHCR_USER (in $ENV_FILE or the environment)}"
: "${GHCR_TOKEN:?set GHCR_TOKEN — a GitHub PAT with read:packages}"
: "${IMAGE:?set IMAGE, e.g. ghcr.io/owner/repo (no tag)}"
# The in-stack Postgres password has no default (docker-compose.yml uses
# ${POSTGRES_PASSWORD:?...}). Fail here with a clear message rather than letting
# `docker compose` abort mid-deploy. If you point DATABASE_URL at managed
# Postgres instead (see docker-compose.prod.yml), set this to any non-empty
# placeholder — compose still interpolates it even for the unused service.
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in $ENV_FILE — the in-stack Postgres password, no default}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
KEEP_IMAGES="${KEEP_IMAGES:-3}"
WEB_PORT="${WEB_PORT:-3000}"
export IMAGE IMAGE_TAG WEB_PORT POSTGRES_PASSWORD   # docker-compose.*.yml interpolates these

case "$IMAGE" in
  ghcr.io/OWNER/REPO|*/OWNER/REPO) echo "refusing to deploy the placeholder IMAGE ($IMAGE) — set it in $ENV_FILE" >&2; exit 2 ;;
esac

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
REF="${IMAGE}:${IMAGE_TAG}"
log() { echo "[deploy] $*"; }

command -v curl >/dev/null || { echo "curl is required on the deploy host" >&2; exit 2; }

log "target: $REF   (keep $KEEP_IMAGES old versions, web port $WEB_PORT)"

# --- 1. authenticate to GHCR ----------------------------------------------
# Packages are private by default. --password-stdin keeps the PAT out of the
# process list and shell history. This is the piece the Render dashboard's
# "Registry Credentials" does for the Render path — on a bare host it's here.
log "docker login ghcr.io as $GHCR_USER"
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

# --- 2. remember the currently-deployed image, for rollback --------------
PREV_IMAGE_ID="$(docker image inspect "$REF" --format '{{.Id}}' 2>/dev/null || true)"
[ -n "$PREV_IMAGE_ID" ] && log "current $REF = ${PREV_IMAGE_ID#sha256:}" || log "no local $REF yet (first deploy)"

# --- 3. pull + restart --------------------------------------------------
log "pull"
"${COMPOSE[@]}" pull

log "up -d"
"${COMPOSE[@]}" up -d

# --- 4. health gate ---------------------------------------------------
# The web entrypoint runs `prisma migrate deploy` BEFORE it serves, so
# /api/health returning 200 also means the schema is current.
log "waiting for http://localhost:${WEB_PORT}/api/health"
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:${WEB_PORT}/api/health"; then healthy=1; break; fi
  sleep 5
done

if [ -z "$healthy" ]; then
  echo "[deploy] FAILED: /api/health not green after 5 min" >&2
  "${COMPOSE[@]}" logs --tail 60 web >&2 || true
  if [ -n "$PREV_IMAGE_ID" ]; then
    log "rolling back $REF -> ${PREV_IMAGE_ID#sha256:}"
    docker tag "$PREV_IMAGE_ID" "$REF"
    "${COMPOSE[@]}" up -d
  else
    log "no previous image to roll back to — leaving the stack as-is for inspection"
  fi
  docker logout ghcr.io >/dev/null 2>&1 || true
  exit 1
fi
log "healthy"

# --- 5. prune ------------------------------------------------------
# ~1.2 GB per image version on a 75 GB disk: without this the host fills up in
# a few dozen deploys. Runs ONLY after a healthy rollout, so the previous good
# image is still present for the rollback path above if this deploy had failed.
#
# `docker images -q <repo>` lists this repo's image IDs newest-first (deduped);
# keep the first KEEP_IMAGES, remove the rest. Then drop any now-dangling
# layers (an old ':latest' that just lost its tag to the new pull).
log "pruning images for $IMAGE (keeping $KEEP_IMAGES)"
docker images -q "$IMAGE" | awk -v k="$KEEP_IMAGES" 'NR > k' | xargs -r docker rmi 2>/dev/null || true
docker image prune -f >/dev/null

docker logout ghcr.io >/dev/null 2>&1 || true
log "done — $REF"
