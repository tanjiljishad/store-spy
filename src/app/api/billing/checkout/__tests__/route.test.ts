import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Security review fix 4: POST /api/billing/checkout's code-bearing path is
 * the same promo brute-force surface as /api/billing/promo/validate (both
 * return a distinguishable "invalid code" error) and must share its
 * 10/hour budget, in a bucket separate from the plain 20/hour checkout
 * limit. Route-level, not integration: processCheckout() itself is
 * untouched by this fix — only the route's own rate-limit keying is — so
 * this mocks processCheckout entirely and asserts on response status.
 */

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {
    constructor() {
      super("Unauthorized");
      this.name = "UnauthorizedError";
    }
  }
  return { requireUser: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
const processCheckoutMock = vi.fn(async () => ({ outcome: "pending" as const, checkoutId: "co_1", finalCents: 1900 }));
vi.mock("@/lib/billing/checkout", () => ({
  processCheckout: (...args: Parameters<typeof processCheckoutMock>) => processCheckoutMock(...args),
}));

const { POST } = await import("../route");
const { requireUser } = await import("@/lib/auth/session");
const { _resetRateLimitState } = await import("@/lib/security/rate-limit");

function actor(id: string) {
  return { id, email: `${id}@example.com`, plan: "FREE" as const, role: "USER" as const };
}

function req(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "BASIC", period: "MONTHLY", ...body }),
  });
}

beforeEach(() => {
  _resetRateLimitState();
  processCheckoutMock.mockClear();
  vi.mocked(requireUser).mockReset();
  vi.mocked(requireUser).mockResolvedValue(actor("user-1"));
});

describe("POST /api/billing/checkout — promo brute-force channel (security review fix 4)", () => {
  it("rate-limits a code-bearing checkout at 10/hour — tighter than the 20/hour plain limit", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(req({ code: `GUESS${i}` }));
      expect(res.status).not.toBe(429);
    }
    const eleventh = await POST(req({ code: "GUESS10" }));
    expect(eleventh.status).toBe(429);
  });

  it("exhausting the code-bearing budget does not throttle a subsequent codeless checkout from the same user", async () => {
    for (let i = 0; i < 10; i++) {
      await POST(req({ code: `GUESS${i}` }));
    }
    expect((await POST(req({ code: "GUESS10" }))).status).toBe(429); // budget confirmed exhausted

    const codeless = await POST(req());
    expect(codeless.status).not.toBe(429);
  });

  it("a codeless checkout never consumes the code-bearing budget — 10 codeless requests leave the promo budget untouched", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(req());
      expect(res.status).not.toBe(429);
    }
    const firstCodeAttempt = await POST(req({ code: "GUESS0" }));
    expect(firstCodeAttempt.status).not.toBe(429);
  });

  it("a different user's code-guessing does not throttle this user's checkout", async () => {
    vi.mocked(requireUser).mockResolvedValue(actor("attacker"));
    for (let i = 0; i < 10; i++) {
      await POST(req({ code: `GUESS${i}` }));
    }
    expect((await POST(req({ code: "GUESS10" }))).status).toBe(429); // attacker's budget confirmed exhausted

    vi.mocked(requireUser).mockResolvedValue(actor("victim"));
    const victimReq = await POST(req({ code: "REALCODE" }));
    expect(victimReq.status).not.toBe(429);
  });

  it("the plain 20/hour limit still applies to codeless checkouts, independent of the promo-specific one", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await POST(req());
      expect(res.status).not.toBe(429);
    }
    const twentyFirst = await POST(req());
    expect(twentyFirst.status).toBe(429);
  });
});
