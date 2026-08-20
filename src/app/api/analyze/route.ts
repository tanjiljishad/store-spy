import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { runAnalysis } from "@/lib/analysis/run-analysis";
import { checkRateLimit, getClientIp } from "@/lib/security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import type { PlanTier } from "@/lib/entitlements/plan-limits";
import type { AnalysisSseEvent } from "@/lib/analysis/types";

export const runtime = "nodejs"; // needs real DNS resolution + Prisma — not available on the Edge runtime

const IP_RATE_LIMIT = { limit: 5, windowMs: 60_000 };
/**
 * A second, independent limiter dimension keyed on userId, not IP. Each
 * accepted request fans out to up to 60 paginated fetches against a real
 * third-party storefront plus review-page sampling — an open outbound-
 * request relay if the only gate is IP-based (per 1.1, that key is
 * spoofable) and the caller can rotate IPs. userId isn't spoofable the way
 * an IP is, so one signed-in account can't burn the crawl budget from many
 * IPs the way it could shed a single IP-only limit.
 */
const USER_RATE_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const MAX_URL_LENGTH = 2048;

function sseLine(event: AnalysisSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  const ipRate = checkRateLimit(`analyze:ip:${ip}`, IP_RATE_LIMIT);
  if (!ipRate.allowed) {
    return Response.json(
      { error: "Too many analysis requests. Try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(ipRate.retryAfterMs / 1000)) } },
    );
  }

  let user;
  try {
    user = await getCurrentUser();
  } catch (e) {
    // Session lookup hits Prisma before the SSE stream is ever constructed —
    // left uncaught, a DB failure here escapes as a raw Next.js 500 page
    // instead of the JSON error shape every other early-return in this route
    // uses, which the client can't parse (see useAnalysisStream.ts).
    console.error("[api/analyze] session lookup failed:", e);
    return Response.json({ error: "Something went wrong on our end. Please try again." }, { status: 500 });
  }

  // Triggering a real, potentially expensive outbound crawl requires an
  // account — see this milestone's doc, item 1.4. The anonymous PREVIEW
  // shape (access: "anonymous_preview") still exists and is still reachable
  // through GET /api/store/[domain]/report for a store someone else already
  // crawled; only the ability to trigger a NEW crawl becomes authenticated.
  if (!user) {
    return Response.json({ error: "Sign in to analyze a store." }, { status: 401 });
  }

  const userRate = checkRateLimit(`analyze:user:${user.id}`, USER_RATE_LIMIT);
  if (!userRate.allowed) {
    return Response.json(
      { error: "You've reached the hourly limit for new analyses. Try again later." },
      { status: 429, headers: { "retry-after": String(Math.ceil(userRate.retryAfterMs / 1000)) } },
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

  const caller = { userId: user.id, plan: user.plan as PlanTier };

  // Shared across start()/cancel() — a client disconnect (nav away, closed
  // tab, dropped connection) invokes cancel() on a SEPARATE method of this
  // same underlying-source object, not inside start()'s own closure. This
  // flag previously lived only inside start(), so cancel()'s comment ("this
  // only stops us from writing to a closed stream") was never actually true:
  // a mid-crawl disconnect left `send()` still calling controller.enqueue()
  // on an already-cancelled controller, throwing "Invalid state: Controller
  // is already closed" and logging a false "analysis crashed" for a request
  // that was simply abandoned by the client, not actually broken. Found via
  // live browser verification (Milestone 7 Sub-phase C) — see the
  // regression test below for the exact reproduction.
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: AnalysisSseEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseLine(event)));
      };

      try {
        await runAnalysis({ prisma, urlInput: url, onEvent: send, caller });
      } catch (e) {
        if (closed) return; // client already disconnected — nothing left to report to
        // Never forward internal error detail/stack traces to the client.
        console.error("[api/analyze] analysis crashed:", e);
        send({
          type: "error",
          status: "failed",
          message: "Something went wrong on our end. Please try again.",
          retryable: true,
        });
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      // Client disconnected. The in-flight crawl in runAnalysis isn't
      // cancelled — it still finishes and persists — this only stops
      // send() from writing to a controller that's no longer there.
      closed = true;
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
