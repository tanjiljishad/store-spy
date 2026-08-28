import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level coverage for the CONTROL_PLANE_INTERNAL_SECRET gate and param
 * validation on GET /api/internal/entitlements. The entitlement resolution
 * itself is covered against a real database in
 * src/lib/control-plane/__tests__/entitlements.integration.test.ts.
 */
import type { EntitlementResult } from "@/lib/control-plane/entitlements";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
const resolveEntitlement = vi.fn<(...args: unknown[]) => Promise<EntitlementResult>>(async () => ({
  allowed: true,
  quota: 10,
  reason: "ok",
}));
vi.mock("@/lib/control-plane/entitlements", () => ({ resolveEntitlement }));

const { GET } = await import("../route");

const ORIGINAL_SECRET = process.env.CONTROL_PLANE_INTERNAL_SECRET;
const REAL = "the-real-internal-secret-value";

function req(opts: { secret?: string; account_id?: string; feature_key?: string }): NextRequest {
  const url = new URL("http://localhost/api/internal/entitlements");
  if (opts.account_id !== undefined) url.searchParams.set("account_id", opts.account_id);
  if (opts.feature_key !== undefined) url.searchParams.set("feature_key", opts.feature_key);
  const headers: Record<string, string> = {};
  if (opts.secret !== undefined) headers["x-internal-secret"] = opts.secret;
  return new NextRequest(url, { method: "GET", headers });
}

beforeEach(() => {
  process.env.CONTROL_PLANE_INTERNAL_SECRET = REAL;
  resolveEntitlement.mockClear();
});
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CONTROL_PLANE_INTERNAL_SECRET;
  else process.env.CONTROL_PLANE_INTERNAL_SECRET = ORIGINAL_SECRET;
});

describe("GET /api/internal/entitlements — auth gate", () => {
  it("fails closed (503) when CONTROL_PLANE_INTERNAL_SECRET is not configured", async () => {
    delete process.env.CONTROL_PLANE_INTERNAL_SECRET;
    const res = await GET(req({ secret: "anything", account_id: "a", feature_key: "k" }));
    expect(res.status).toBe(503);
    expect(resolveEntitlement).not.toHaveBeenCalled();
  });

  it("rejects (401) a missing header", async () => {
    const res = await GET(req({ account_id: "a", feature_key: "k" }));
    expect(res.status).toBe(401);
  });

  it("rejects (401) a wrong secret", async () => {
    const res = await GET(req({ secret: "nope", account_id: "a", feature_key: "k" }));
    expect(res.status).toBe(401);
  });

  it("rejects (401) a same-length-but-wrong secret (exercises the constant-time path, not just a length guard)", async () => {
    const res = await GET(req({ secret: "the-real-internal-secret-VALUE", account_id: "a", feature_key: "k" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/internal/entitlements — params", () => {
  it("400 when account_id is missing", async () => {
    const res = await GET(req({ secret: REAL, feature_key: "store_spy.analysis.run" }));
    expect(res.status).toBe(400);
    expect(resolveEntitlement).not.toHaveBeenCalled();
  });

  it("400 when feature_key is missing", async () => {
    const res = await GET(req({ secret: REAL, account_id: "acc_1" }));
    expect(res.status).toBe(400);
  });

  it("200 with the resolver's result, passing account_id + feature_key through verbatim", async () => {
    resolveEntitlement.mockResolvedValueOnce({ allowed: false, quota: 1, reason: "trial_expired" });
    const res = await GET(req({ secret: REAL, account_id: "acc_1", feature_key: "store_spy.monitoring.slots" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, quota: 1, reason: "trial_expired" });
    expect(resolveEntitlement).toHaveBeenCalledWith(expect.anything(), {
      accountId: "acc_1",
      featureKey: "store_spy.monitoring.slots",
    });
  });

  it("never returns a `used` field", async () => {
    resolveEntitlement.mockResolvedValueOnce({ allowed: true, quota: null, reason: "ok" });
    const res = await GET(req({ secret: REAL, account_id: "acc_1", feature_key: "store_spy.intelligence.advanced" }));
    expect(await res.json()).not.toHaveProperty("used");
  });
});
