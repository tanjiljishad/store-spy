import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/**
 * Exercises the actual POST/DELETE route handlers for
 * /api/store/[domain]/watch — the HTTP-layer auth gate, 404 handling, and
 * entitlement-error shape, not just startMonitoring/stopMonitoring
 * directly (see watch.integration.test.ts for those).
 *
 * getCurrentUser is mocked at this one seam rather than driving a real
 * NextAuth cookie through the JWT encoder — Auth.js v5's own types
 * explicitly discourage constructing session JWTs by hand server-side.
 * The real cookie-based path is covered by the live HTTP smoke test
 * (a genuine signup + credentials sign-in), not by this suite.
 */

const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { POST: watchPost, DELETE: watchDelete } = await import("../../../app/api/store/[domain]/watch/route");
const { _resetRateLimitState } = await import("../../security/rate-limit");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
}
if (!/test/i.test(url)) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`,
  );
}

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  mockGetCurrentUser.mockReset();
  await resetControlPlane(prisma);
});

function req(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: { "x-forwarded-for": "203.0.113.5", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
async function makeUser(plan: "FREE" | "BASIC" | "BUSINESS" = "FREE") {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan });
}

describe("POST /api/store/[domain]/watch", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const store = await makeStore();

    const res = await watchPost(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(401);
  });

  it("404s a domain that was never analyzed", async () => {
    mockGetCurrentUser.mockResolvedValue({ id: "some-user", email: "u@example.com", plan: "FREE" });

    const res = await watchPost(req("/api/store/never-seen.com/watch"), { params: Promise.resolve({ domain: "never-seen.com" }) });
    expect(res.status).toBe(404);
  });

  it("starts monitoring for a real signed-in user", async () => {
    const user = await makeUser();
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    const store = await makeStore();

    const res = await watchPost(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ACTIVE");
    // Milestone 12 §1.4: a FREE watch now carries the account's trial
    // ceiling (min(freeTrialEndsAt, watchExpiry), watchExpiry itself still
    // null) rather than never expiring at all. The trial end is the subt_
    // subscription's period_end — the value makeStoreSpyUser echoes back.
    expect(body.expiresAt).toBe(user.freeTrialEndsAt.toISOString());
  });

  it("returns the structured entitlement-denied shape, not a raw 500, once the free slot is used", async () => {
    const user = await makeUser();
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    const storeA = await makeStore();
    const storeB = await makeStore();

    await watchPost(req(`/api/store/${storeA.domain}/watch`), { params: Promise.resolve({ domain: storeA.domain }) });
    const res = await watchPost(req(`/api/store/${storeB.domain}/watch`), { params: Promise.resolve({ domain: storeB.domain }) });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ code: "LIMIT_REACHED", limit: "MONITORED_STORES", current: 1, max: 1, upgradeTo: "BASIC" });
  });

  it("ignores any client-supplied body — expiry, status, and duration are always computed server-side", async () => {
    const user = await makeUser();
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    const store = await makeStore();

    const maliciousBody = {
      monitoringExpiresAt: "2099-01-01T00:00:00Z",
      monitoringStatus: "ACTIVE",
      monitoringStartedAt: "2000-01-01T00:00:00Z",
      userId: "someone-elses-id",
    };
    const res = await watchPost(req(`/api/store/${store.domain}/watch`, maliciousBody), {
      params: Promise.resolve({ domain: store.domain }),
    });
    expect(res.status).toBe(200);

    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    // The real point this test makes still holds: the attacker-supplied
    // 2099 date is ignored — it's server-computed (the trial ceiling,
    // Milestone 12 §1.4), never the spoofed value.
    expect(watch.monitoringExpiresAt!.getTime()).toBe(user.freeTrialEndsAt.getTime());
    expect(watch.monitoringExpiresAt!.getFullYear()).not.toBe(2099);
    expect(watch.userId).toBe(user.id); // never the spoofed "someone-elses-id"
  });

  it("user isolation: user B starting a watch never touches user A's watch row", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const store = await makeStore();

    mockGetCurrentUser.mockResolvedValue({ id: userA.id, email: userA.email, plan: "FREE" });
    await watchPost(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });

    mockGetCurrentUser.mockResolvedValue({ id: userB.id, email: userB.email, plan: "FREE" });
    const res = await watchPost(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(200); // userB has their own independent slot

    const watchA = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: userA.id, storeId: store.id } } });
    expect(watchA.monitoringStatus).toBe("ACTIVE"); // untouched by userB's action
  });
});

describe("DELETE /api/store/[domain]/watch", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const store = await makeStore();

    const res = await watchDelete(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(401);
  });

  it("user A cannot remove user B's monitoring by calling DELETE while signed in as A", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const store = await makeStore();

    mockGetCurrentUser.mockResolvedValue({ id: userB.id, email: userB.email, plan: "FREE" });
    await watchPost(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });

    mockGetCurrentUser.mockResolvedValue({ id: userA.id, email: userA.email, plan: "FREE" });
    await watchDelete(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });

    // userA had no watch to begin with (no-op); userB's remains untouched.
    const watchB = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: userB.id, storeId: store.id } } });
    expect(watchB.monitoringStatus).toBe("ACTIVE");
  });

  it("stops the caller's own monitoring", async () => {
    const user = await makeUser();
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    const store = await makeStore();
    await watchPost(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });

    const res = await watchDelete(req(`/api/store/${store.domain}/watch`), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(200);

    const watch = await prisma.watchlist.findUniqueOrThrow({ where: { userId_storeId: { userId: user.id, storeId: store.id } } });
    expect(watch.monitoringStatus).toBe("REMOVED");
  });
});
