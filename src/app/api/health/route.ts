import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";
// Never cached: a health check must reflect the process's state right now,
// not whatever it was when the route was first rendered.
export const dynamic = "force-dynamic";

/**
 * Liveness + database-connectivity probe. `render.yaml`'s `healthCheckPath`
 * points here, and the docker-compose `web` service's healthcheck hits it.
 *
 * Deliberately unauthenticated and side-effect-free: one `SELECT 1` against
 * the same pool the app uses, with a short timeout so a hung/unreachable
 * database turns into a fast `503` instead of the load balancer's own
 * (longer) timeout. Returns no app data — just `ok` / `down` for `db`.
 */
const DB_TIMEOUT_MS = 2000;

export async function GET() {
  let dbOk = false;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("db check timed out")), DB_TIMEOUT_MS)),
    ]);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return Response.json(
    { status: dbOk ? "ok" : "degraded", db: dbOk ? "ok" : "down" },
    { status: dbOk ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
