import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit-level (no real Postgres, no real crawl): mocks runAnalysis entirely
 * so this test can precisely control WHEN each SSE event fires relative to
 * a simulated client disconnect — something a real integration test against
 * a live crawl couldn't reliably time.
 *
 * Regression coverage for a real bug found via live browser verification
 * (Milestone 7 Sub-phase C): navigating away from the analyze page mid-crawl
 * previously caused `[api/analyze] analysis crashed: TypeError: Invalid
 * state: Controller is already closed` — cancel() claimed to stop further
 * writes to the closed stream but never actually set the flag send() checked,
 * because the two lived in separate closures. See route.ts's `closed` comment.
 */

let releaseSecondEvent: (() => void) | null = null;
const runAnalysisMock = vi.fn(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
  onEvent({ type: "status", status: "validating" });
  await new Promise<void>((resolve) => {
    releaseSecondEvent = resolve;
  });
  // This is the call that, pre-fix, fired AFTER the simulated disconnect
  // below and threw because the controller was already gone.
  onEvent({ type: "progress", phase: "fetching_products", message: "…", detail: null });
  onEvent({ type: "status", status: "complete" });
});

vi.mock("@/lib/analysis/run-analysis", () => ({
  runAnalysis: (...args: Parameters<typeof runAnalysisMock>) => runAnalysisMock(...args),
}));
// Milestone 12 §1.3: the anonymous path no longer 401s — it calls this
// instead. Mocked separately so tests can assert exactly which of the two
// orchestrators a given request reaches, and with what arguments.
const runAnonymousProbeMock = vi.fn(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
  onEvent({ type: "status", status: "validating" });
  onEvent({ type: "complete", report: { access: "anonymous_probe" } });
});
vi.mock("@/lib/analysis/anonymous-probe", () => ({
  runAnonymousProbe: (...args: Parameters<typeof runAnonymousProbeMock>) => runAnonymousProbeMock(...args),
}));
// Defaults to a signed-in user. The anonymous case gets its own describe
// block below, which overrides this per-test.
const getCurrentUserMock = vi.fn<() => Promise<{ id: string; email: string } | null>>(async () => ({
  id: "user-1",
  email: "user@example.com",
}));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
// The route fetches a coarse plan label for the LIMIT_REACHED envelope; this
// suite is about routing / SSE lifecycle, so stub it.
vi.mock("@/lib/control-plane/entitlements", () => ({ getPurchasedPlanSlug: vi.fn(async () => "FREE") }));

const { POST } = await import("../../../app/api/analyze/route");
const { _resetRateLimitState } = await import("../../security/rate-limit");

beforeEach(() => {
  _resetRateLimitState();
  runAnalysisMock.mockClear();
  runAnonymousProbeMock.mockClear();
  getCurrentUserMock.mockClear();
  getCurrentUserMock.mockResolvedValue({ id: "user-1", email: "user@example.com" });
  releaseSecondEvent = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function req(headers: Record<string, string> = {}, body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77", ...headers },
    body: JSON.stringify({ url: "https://example.com", ...body }),
  });
}

describe("POST /api/analyze — SSE stream cancellation safety", () => {
  it("does not log a false 'analysis crashed' when the client disconnects mid-analysis", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req());
    const reader = res.body!.getReader();

    // Read the first real event, proving the stream is live.
    const first = await reader.read();
    expect(first.done).toBe(false);

    // Simulate the client navigating away: cancel the stream before
    // runAnalysis's second onEvent() call fires.
    await reader.cancel();

    // Now let the in-flight "crawl" continue past the disconnect point —
    // this is exactly the sequence that used to throw.
    expect(releaseSecondEvent).not.toBeNull();
    releaseSecondEvent!();

    // Give the still-running async work a tick to reach send() again.
    await new Promise((r) => setTimeout(r, 20));

    const crashLogs = errorSpy.mock.calls.filter((c) => String(c[0]).includes("analysis crashed"));
    expect(crashLogs).toHaveLength(0);
  });

  it("still delivers every event normally when the client stays connected", async () => {
    const res = await POST(req());
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    const first = await reader.read();
    text += decoder.decode(first.value);
    releaseSecondEvent!();

    for (let i = 0; i < 5; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }

    expect(text).toContain('"status":"validating"');
    expect(text).toContain('"phase":"fetching_products"');
    expect(text).toContain('"status":"complete"');
  });
});

describe("POST /api/analyze — authenticated vs. anonymous routing (Milestone 12 §1.3)", () => {
  it("a signed-in caller reaches runAnalysis, never runAnonymousProbe", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    releaseSecondEvent!();
    expect(runAnalysisMock).toHaveBeenCalledTimes(1);
    expect(runAnonymousProbeMock).not.toHaveBeenCalled();
  });

  it("an anonymous caller reaches runAnonymousProbe, never runAnalysis or a 401 — Milestone 11 fix 1.4 is narrowed, not reverted", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(runAnonymousProbeMock).toHaveBeenCalledTimes(1);
    expect(runAnalysisMock).not.toHaveBeenCalled();
  });

  it("passes the anonymous caller's turnstileToken from the request body through to runAnonymousProbe", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await POST(req({}, { turnstileToken: "a-real-token" }));

    expect(runAnonymousProbeMock).toHaveBeenCalledWith(expect.objectContaining({ turnstileToken: "a-real-token" }));
  });

  it("passes null turnstileToken through when the anonymous caller supplied none — never invented, never defaulted to a truthy placeholder", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await POST(req());

    expect(runAnonymousProbeMock).toHaveBeenCalledWith(expect.objectContaining({ turnstileToken: null }));
  });

  // Regression test against Milestone 11 fix 1.1, per this milestone's own
  // explicit instruction: a spoofed x-forwarded-for prefix must not change
  // which ipKey the anonymous quota gets keyed on. Mirrors the pattern
  // already established in rate-limit.test.ts's own getClientIp regression
  // test — here verified one layer up, at the actual route boundary that
  // feeds runAnonymousProbe (and, downstream, recordAnonymousAnalysis).
  it("a spoofed x-forwarded-for prefix does not change the ipKey passed to runAnonymousProbe (regression against fix 1.1)", async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await POST(req({ "x-forwarded-for": "203.0.113.5" }));
    const cleanIpKey = (runAnonymousProbeMock.mock.calls[0][0] as unknown as { ipKey: string }).ipKey;
    runAnonymousProbeMock.mockClear();

    await POST(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.5" }));
    const spoofedIpKey = (runAnonymousProbeMock.mock.calls[0][0] as unknown as { ipKey: string }).ipKey;

    expect(spoofedIpKey).toBe(cleanIpKey);
    expect(spoofedIpKey).not.toBe("1.2.3.4"); // the attacker-supplied prefix must never win
  });

  it("rate-limits by userId (10/hour), independent of the per-IP limiter", async () => {
    // Each request uses a fresh IP, so only the userId dimension can be
    // what eventually blocks these — proving it exists as its own limiter,
    // not just riding on the IP one.
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const request = new NextRequest("http://localhost/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${100 + i}` },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const res = await POST(request);
      lastStatus = res.status;
      if (res.status === 200) releaseSecondEvent?.();
    }
    expect(lastStatus).toBe(429);
  });
});
