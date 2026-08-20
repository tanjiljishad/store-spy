import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level coverage for the constant-time SCHEDULER_SECRET comparison
 * (this milestone's doc, item 1.9) — previously zero test coverage existed
 * for either scheduler route at all.
 */
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/monitoring/scheduler", () => ({ runSchedulerTick: vi.fn(async () => ({ claimed: 0 })) }));
vi.mock("@/lib/marketing/scheduler", () => ({ runMarketingSchedulerTick: vi.fn(async () => ({ claimed: 0 })) }));
vi.mock("@/lib/marketing/source-factory", () => ({ getConfiguredMarketingSource: vi.fn(() => ({})) }));

const { POST: shopifyTick } = await import("../../../app/api/internal/scheduler/tick/route");
const { POST: marketingTick } = await import("../../../app/api/internal/scheduler/marketing-tick/route");

const ORIGINAL_SECRET = process.env.SCHEDULER_SECRET;

function req(headerValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (headerValue !== undefined) headers["x-scheduler-secret"] = headerValue;
  return new NextRequest("http://localhost/api/internal/scheduler/tick", { method: "POST", headers });
}

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.SCHEDULER_SECRET;
  else process.env.SCHEDULER_SECRET = ORIGINAL_SECRET;
});

describe.each([
  { name: "shopify tick", handler: shopifyTick },
  { name: "marketing tick", handler: marketingTick },
])("$name — SCHEDULER_SECRET gate", ({ handler }) => {
  beforeEach(() => {
    process.env.SCHEDULER_SECRET = "the-real-secret-value";
  });

  it("fails closed (503) when SCHEDULER_SECRET is not configured", async () => {
    delete process.env.SCHEDULER_SECRET;
    const res = await handler(req("anything"));
    expect(res.status).toBe(503);
  });

  it("rejects (401) a missing header", async () => {
    const res = await handler(req());
    expect(res.status).toBe(401);
  });

  it("rejects (401) a wrong secret", async () => {
    const res = await handler(req("the-wrong-value"));
    expect(res.status).toBe(401);
  });

  it("rejects (401) a same-length-but-wrong secret — exercises the timingSafeEqual path, not just the length guard", async () => {
    const res = await handler(req("the-real-secret-VALUE"));
    expect(res.status).toBe(401);
  });

  it("accepts the correct secret", async () => {
    const res = await handler(req("the-real-secret-value"));
    expect(res.status).toBe(200);
  });
});
