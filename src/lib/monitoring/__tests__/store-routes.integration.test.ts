import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises the actual exported route handlers (not just the query
 * functions underneath) — proves the HTTP layer's domain resolution, 404
 * handling, access gating, and rate limiting are wired correctly, end to
 * end.
 *
 * Milestone 11, item 1.3: these two routes didn't call getCurrentUser() at
 * all before this milestone, so this suite never needed to touch auth. Now
 * that they do, importing them pulls in @/lib/auth/session -> auth.ts ->
 * next-auth's whole provider chain — loading that for real inside vitest's
 * SSR module loader hits an unrelated ESM-resolution issue in next-auth's
 * own "next/server" import (see store-access.integration.test.ts's own
 * comment for the same issue and fix). A full synthetic mock of
 * @/lib/auth/session avoids ever loading that chain.
 */
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(),
}));

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET as getEvents } from "../../../app/api/store/[domain]/events/route";
import { GET as getActivity } from "../../../app/api/store/[domain]/activity/route";
import { _resetRateLimitState } from "../../security/rate-limit";
import { getCurrentUser } from "@/lib/auth/session";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

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
    `TRUNCATE "AnalysisUsage","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Session","Account","Store" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  vi.mocked(getCurrentUser).mockReset();
  await resetControlPlane(prisma);
});

function req(path: string, ip = "203.0.113.1"): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: { "x-forwarded-for": ip } });
}

/** A signed-in user who has already analyzed `storeId` — clears the store-access.ts gate. */
async function signInAsAnalyzerOf(storeId: string): Promise<void> {
  const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });
  await prisma.analysisUsage.create({ data: { userId: user.id, storeId } });
  vi.mocked(getCurrentUser).mockResolvedValue({ id: user.id, email: user.email, role: "USER" });
}

describe("GET /api/store/[domain]/events", () => {
  it("404s for a domain that has never been analyzed, before any access check", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await getEvents(req("/api/store/never-seen.com/events"), {
      params: Promise.resolve({ domain: "never-seen.com" }),
    });
    expect(res.status).toBe(404);
  });

  it("401s an anonymous caller for a known store (see store-access.ts)", async () => {
    await prisma.store.create({ data: { domain: "known.com", platform: "SHOPIFY" } });
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const res = await getEvents(req("/api/store/known.com/events"), {
      params: Promise.resolve({ domain: "known.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns a real (empty) page for a known store the caller HAS analyzed", async () => {
    const store = await prisma.store.create({ data: { domain: "known.com", platform: "SHOPIFY" } });
    await signInAsAnalyzerOf(store.id);

    const res = await getEvents(req("/api/store/known.com/events"), {
      params: Promise.resolve({ domain: "known.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("rate limits after too many requests from the same client", async () => {
    const store = await prisma.store.create({ data: { domain: "rl.com", platform: "SHOPIFY" } });
    await signInAsAnalyzerOf(store.id);
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;

    let last: Response | undefined;
    for (let i = 0; i < 35; i++) {
      last = await getEvents(req("/api/store/rl.com/events", ip), { params: Promise.resolve({ domain: "rl.com" }) });
    }
    expect(last!.status).toBe(429);
  });
});

describe("GET /api/store/[domain]/activity", () => {
  it("404s for an unknown store, before any access check", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const res = await getActivity(req("/api/store/never-seen.com/activity"), {
      params: Promise.resolve({ domain: "never-seen.com" }),
    });
    expect(res.status).toBe(404);
  });

  it("401s an anonymous caller for a known store", async () => {
    await prisma.store.create({ data: { domain: "fresh.com", platform: "SHOPIFY" } });
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const res = await getActivity(req("/api/store/fresh.com/activity"), {
      params: Promise.resolve({ domain: "fresh.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns the honest not-enough-history state for a freshly baselined store the caller HAS analyzed", async () => {
    const store = await prisma.store.create({ data: { domain: "fresh.com", platform: "SHOPIFY" } });
    await prisma.crawl.create({ data: { storeId: store.id, status: "OK" } });
    await signInAsAnalyzerOf(store.id);

    const res = await getActivity(req("/api/store/fresh.com/activity"), {
      params: Promise.resolve({ domain: "fresh.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.hasEnoughHistory).toBe(false);
    expect(body.signals).toEqual([]);
  });

  it("clamps windowDays into a sane range instead of trusting the query param blindly", async () => {
    const store = await prisma.store.create({ data: { domain: "clamp.com", platform: "SHOPIFY" } });
    await signInAsAnalyzerOf(store.id);

    const res = await getActivity(req("/api/store/clamp.com/activity?windowDays=99999"), {
      params: Promise.resolve({ domain: "clamp.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.windowDays).toBeLessThanOrEqual(90);
  });

  it("URL-decodes and canonicalizes the domain param", async () => {
    const store = await prisma.store.create({ data: { domain: "unicode-test.com", platform: "SHOPIFY" } });
    await signInAsAnalyzerOf(store.id);

    const res = await getActivity(req(`/api/store/${encodeURIComponent("https://www.unicode-test.com")}/activity`), {
      params: Promise.resolve({ domain: encodeURIComponent("https://www.unicode-test.com") }),
    });
    expect(res.status).toBe(200);
  });
});
