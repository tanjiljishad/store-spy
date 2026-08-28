import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/** getCurrentUser mocked at this one seam — see watch-route.integration.test.ts (Sub-phase A) for why. */
const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { GET: dashboardGet } = await import("../../../app/api/dashboard/route");
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

function req(): NextRequest {
  return new NextRequest("http://localhost/api/dashboard", { headers: { "x-forwarded-for": "203.0.113.30" } });
}

describe("GET /api/dashboard", () => {
  it("401s an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await dashboardGet(req());
    expect(res.status).toBe(401);
  });

  it("returns a real summary for a signed-in user", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });

    const res = await dashboardGet(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Milestone 12 §1.1/§1.2: FREE's real windowed limit is 10/24h, not unlimited.
    expect(body).toMatchObject({ plan: "FREE", analyses: { used: 0, limit: 10, stores: [] } });
  });

  it("never exposes internal database ids — only derived, presentation-ready fields", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });

    const res = await dashboardGet(req());
    const body = (await res.json()) as unknown;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(user.id); // no raw User.id leaked into the payload
  });
});
