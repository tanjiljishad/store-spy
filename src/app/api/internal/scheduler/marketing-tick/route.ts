import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { runMarketingSchedulerTick } from "@/lib/marketing/scheduler";
import { getConfiguredMarketingSource } from "@/lib/marketing/source-factory";

export const runtime = "nodejs";

/**
 * Cron-triggered entry point for the marketing-intelligence collection
 * tick — deliberately a SEPARATE route from /api/internal/scheduler/tick
 * (the Shopify crawl scheduler), so a slow or rate-limited paid-vendor
 * cycle can never delay or block the free Shopify crawl schedule. Same
 * fail-closed SCHEDULER_SECRET gate as the Shopify tick route.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.SCHEDULER_SECRET;
  if (!expected) {
    console.error("[marketing-scheduler/tick] SCHEDULER_SECRET is not configured — refusing all requests");
    return Response.json({ error: "Scheduler is not configured" }, { status: 503 });
  }

  const provided = req.headers.get("x-scheduler-secret");
  if (provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let source;
  try {
    source = getConfiguredMarketingSource();
  } catch (e) {
    console.error("[marketing-scheduler/tick]", e);
    return Response.json({ error: "Marketing vendor is not configured" }, { status: 503 });
  }

  const result = await runMarketingSchedulerTick({ prisma, source });
  return Response.json(result);
}
