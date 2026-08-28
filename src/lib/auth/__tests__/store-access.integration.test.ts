import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These four routes call getCurrentUser() from @/lib/auth/session, which in
 * turn calls next-auth's own auth() to read an encrypted session cookie
 * this test has no real one for. A FULL synthetic mock (not importOriginal)
 * is deliberate here, not just convenient: session.ts unconditionally
 * imports auth.ts at module load time, and auth.ts pulls in next-auth's
 * whole provider chain — loading that for real inside vitest's SSR module
 * loader hits an unrelated ESM-resolution issue in next-auth's own
 * "next/server" import that has nothing to do with what this test verifies
 * (resolveStoreAccess()'s 401/403/200 gating). Replacing the module outright
 * avoids ever loading that chain at all, not just avoiding calling it.
 */
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(),
}));

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { GET as eventsGet } from "../../../app/api/store/[domain]/events/route";
import { GET as activityGet } from "../../../app/api/store/[domain]/activity/route";
import { GET as growthGet } from "../../../app/api/store/[domain]/growth/route";
import { GET as marketingGet } from "../../../app/api/store/[domain]/marketing/route";
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
    `TRUNCATE "AnalysisUsage","Watchlist","Session","Account","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","User","Store" RESTART IDENTITY CASCADE`,
  );
  _resetRateLimitState();
  await resetControlPlane(prisma);
});

function mockSignedInAs(userId: string) {
  vi.mocked(getCurrentUser).mockResolvedValue({ id: userId, email: "", plan: "FREE", role: "USER" });
}
function mockAnonymous() {
  vi.mocked(getCurrentUser).mockResolvedValue(null);
}

async function makeStore() {
  return prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
async function makeUser() {
  return makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });
}

function req(domain: string, path: string): NextRequest {
  return new NextRequest(`http://localhost/api/store/${encodeURIComponent(domain)}/${path}`, {
    headers: { "x-forwarded-for": "203.0.113.50" },
  });
}

const routes = [
  { name: "events", handler: eventsGet },
  { name: "activity", handler: activityGet },
  { name: "growth", handler: growthGet },
  { name: "marketing", handler: marketingGet },
];

describe.each(routes)("GET /api/store/[domain]/$name", ({ name, handler }) => {
  it("returns 401 for an anonymous caller", async () => {
    mockAnonymous();
    const store = await makeStore();
    const res = await handler(req(store.domain, name), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 with STORE_NOT_ANALYZED for a signed-in caller who hasn't analyzed this store", async () => {
    const store = await makeStore();
    const user = await makeUser();
    mockSignedInAs(user.id);
    const res = await handler(req(store.domain, name), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("STORE_NOT_ANALYZED");
  });

  it("returns 200 for a caller who has analyzed this store", async () => {
    const store = await makeStore();
    const user = await makeUser();
    await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    mockSignedInAs(user.id);
    const res = await handler(req(store.domain, name), { params: Promise.resolve({ domain: store.domain }) });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a domain with no Store row, before any access check", async () => {
    mockAnonymous();
    const res = await handler(req("no-such-store-domain.com", name), {
      params: Promise.resolve({ domain: "no-such-store-domain.com" }),
    });
    expect(res.status).toBe(404);
  });
});
