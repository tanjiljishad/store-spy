#!/bin/sh
# One image, two roles. `docker run … web` (the default) applies pending
# migrations then starts the Next server; `docker run … worker` starts the
# scheduler worker and never touches migrations — exactly one process migrates
# per deploy, matching render.yaml's preDeployCommand-on-web-only rule.
set -e

ROLE="${1:-web}"

case "$ROLE" in
  web)
    echo "[entrypoint] prisma migrate deploy"
    ./node_modules/.bin/prisma migrate deploy
    echo "[entrypoint] starting web server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
    exec node server.js
    ;;
  worker)
    echo "[entrypoint] starting scheduler worker"
    exec ./node_modules/.bin/tsx scripts/worker.ts
    ;;
  *)
    # Escape hatch for one-off commands: `docker run … node -e ...`, a shell, etc.
    exec "$@"
    ;;
esac
