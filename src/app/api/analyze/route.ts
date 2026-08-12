import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { runAnalysis } from "@/lib/analysis/run-analysis";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { AnalysisSseEvent } from "@/lib/analysis/types";

export const runtime = "nodejs"; // needs real DNS resolution + Prisma — not available on the Edge runtime

const RATE_LIMIT = { limit: 5, windowMs: 60_000 };
const MAX_URL_LENGTH = 2048;

function sseLine(event: AnalysisSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const rate = checkRateLimit(`analyze:${ip}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: "Too many analysis requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const url = isRecord(body) && typeof body.url === "string" ? body.url : null;
  if (!url || url.length === 0) {
    return Response.json({ error: "Missing 'url' field" }, { status: 400 });
  }
  if (url.length > MAX_URL_LENGTH) {
    return Response.json({ error: "URL is too long" }, { status: 400 });
  }

  const user = await getCurrentUser();
  const caller = user ? { userId: user.id, plan: user.plan as PlanTier } : null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: AnalysisSseEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseLine(event)));
      };

      try {
        await runAnalysis({ prisma, urlInput: url, onEvent: send, caller });
      } catch (e) {
        // Never forward internal error detail/stack traces to the client.
        console.error("[api/analyze] analysis crashed:", e);
        send({
          type: "error",
          status: "failed",
          message: "Something went wrong on our end. Please try again.",
          retryable: true,
        });
      } finally {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      // Client disconnected (navigated away, closed tab). The in-flight
      // crawl in runAnalysis isn't cancelled — it still finishes and
      // persists — this only stops us from writing to a closed stream.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // disable nginx response buffering, if ever deployed behind one
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
