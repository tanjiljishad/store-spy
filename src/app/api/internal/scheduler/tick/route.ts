import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { runSchedulerTick } from "@/lib/monitoring/scheduler";
import { constantTimeEqual } from "@/lib/security/constant-time-equal";

export const runtime = "nodejs"; // needs Prisma + real DNS resolution, not available on Edge

/**
 * Cron-triggered entry point (e.g. Vercel Cron) for the same scheduler tick
 * `npm run scheduler:tick` runs locally. Fails CLOSED: if SCHEDULER_SECRET
 * isn't configured, this refuses every request rather than silently
 * accepting unauthenticated ones — an unauthenticated trigger for real
 * outbound crawls is a resource-abuse vector, not just an info leak.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.SCHEDULER_SECRET;
  if (!expected) {
    console.error("[scheduler/tick] SCHEDULER_SECRET is not configured — refusing all requests");
    return Response.json({ error: "Scheduler is not configured" }, { status: 503 });
  }

  const provided = req.headers.get("x-scheduler-secret");
  if (!provided || !constantTimeEqual(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runSchedulerTick({ prisma });
  return Response.json(result);
}
