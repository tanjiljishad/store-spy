import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../route";

/**
 * TEMPORARY route, but its guard is exactly the thing that must not have a
 * bug — a broken guard on a public host is the failure mode the operator
 * flagged. Kept minimal; deleted along with the route itself.
 */
const ORIGINAL_SECRET = process.env.SCHEDULER_SECRET;

beforeEach(() => {
  process.env.SCHEDULER_SECRET = "the-real-secret-value";
});
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.SCHEDULER_SECRET;
  else process.env.SCHEDULER_SECRET = ORIGINAL_SECRET;
});

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/internal/debug/headers", { headers });
}

describe("GET /api/internal/debug/headers", () => {
  it("404s with no secret header at all — never 401, so an unauthenticated probe can't confirm the route exists", async () => {
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it("404s a wrong secret", async () => {
    const res = await GET(req({ "x-scheduler-secret": "wrong" }));
    expect(res.status).toBe(404);
  });

  it("404s (fails closed) when SCHEDULER_SECRET itself is unset", async () => {
    delete process.env.SCHEDULER_SECRET;
    const res = await GET(req({ "x-scheduler-secret": "anything" }));
    expect(res.status).toBe(404);
  });

  it("200s with the correct secret and echoes the requested headers", async () => {
    const res = await GET(
      req({
        "x-scheduler-secret": "the-real-secret-value",
        "x-forwarded-for": "1.2.3.4, 203.0.113.5",
        "x-forwarded-host": "app.example.com",
        forwarded: "for=203.0.113.5",
        "x-real-ip": "203.0.113.5",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      xForwardedFor: "1.2.3.4, 203.0.113.5",
      xForwardedHost: "app.example.com",
      forwarded: "for=203.0.113.5",
      xRealIp: "203.0.113.5",
      computedClientIp: "203.0.113.5",
    });
  });
});
