import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCurrentUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { GET: reportGet } = await import("../../../app/api/store/[domain]/report/route");
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
});

function req(domain: string): NextRequest {
  return new NextRequest(`http://localhost/api/store/${domain}/report`, { headers: { "x-forwarded-for": "203.0.113.40" } });
}
async function makeStore(domain: string) {
  return prisma.store.create({ data: { domain, platform: "SHOPIFY", themeName: "Dawn" } });
}

describe("GET /api/store/[domain]/report", () => {
  it("404s a domain that was never crawled", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await reportGet(req("never-seen.com"), { params: Promise.resolve({ domain: "never-seen.com" }) });
    expect(res.status).toBe(404);
  });

  it("returns the truncated anonymous_preview shape for an anonymous caller", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await makeStore("anon-view.com");

    const res = await reportGet(req("anon-view.com"), { params: Promise.resolve({ domain: "anon-view.com" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access).toBe("anonymous_preview");
    expect(Object.keys(body)).not.toContain("apps"); // full-report-only field
  });

  it("returns unanalyzed_preview for a signed-in user who hasn't spent a credit on this store", async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    await makeStore("not-mine.com");

    const res = await reportGet(req("not-mine.com"), { params: Promise.resolve({ domain: "not-mine.com" }) });
    const body = await res.json();
    expect(body.access).toBe("unanalyzed_preview");
    expect(body.cta).toMatch(/analyze/i);
  });

  it("returns the full report for a store the user HAS analyzed", async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    const store = await makeStore("mine.com");
    await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });

    const res = await reportGet(req("mine.com"), { params: Promise.resolve({ domain: "mine.com" }) });
    const body = await res.json();
    expect(body.access).toBe("full");
    // Milestone 7 Sub-phase B: the full report is now the canonical,
    // sectioned StoreIntelligenceReport shape — see intelligence/types.ts.
    expect(body.identity.theme).toEqual({ status: "OBSERVED", value: { name: "Dawn", version: null } });
    expect(body.commercial.revenue).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
    // Zero active products — averagePrice is honestly UNAVAILABLE, not $0.00.
    expect(body.catalog.averagePrice).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
    // New in Sub-phase B: pixels/payment providers surfaced, honestly empty here.
    expect(body.technology.pixels).toEqual({ status: "OBSERVED", value: [] });
    expect(body.technology.paymentProviders).toEqual({ status: "OBSERVED", value: [] });
    // No fabricated composite score anywhere in the composed report. (Not matching
    // the bare word "confidence" — matchConfidence is a legitimate, pre-existing
    // Milestone 4 field, and IntelligenceField's own ESTIMATED/INFERRED confidence
    // is an approved part of the epistemic-status system — see the sibling
    // assertion in intelligence/__tests__/report.integration.test.ts for detail.)
    expect(JSON.stringify(body)).not.toMatch(/opportunityScore|storeScore|growthScore|competitorScore/i);
  });

  it("computes a real averagePrice once the store has active products, instead of a fabricated placeholder", async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
    mockGetCurrentUser.mockResolvedValue({ id: user.id, email: user.email, plan: "FREE" });
    const store = await makeStore("priced.com");
    await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.product.createMany({
      data: [
        { storeId: store.id, externalId: "1", handle: "p1", title: "P1", priceMinCents: 1000, priceMaxCents: 1000 },
        { storeId: store.id, externalId: "2", handle: "p2", title: "P2", priceMinCents: 2000, priceMaxCents: 2000 },
      ],
    });

    const res = await reportGet(req("priced.com"), { params: Promise.resolve({ domain: "priced.com" }) });
    const body = await res.json();
    expect(body.catalog.averagePrice).toEqual({ status: "OBSERVED", value: 1500 }); // real average of $10.00 and $20.00
  });

  it("user isolation: user B viewing a store user A analyzed sees unanalyzed_preview, not A's full report", async () => {
    const userA = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
    const userB = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, plan: "FREE" } });
    const store = await makeStore("shared-corpus-store.com");
    await prisma.analysisUsage.create({ data: { userId: userA.id, storeId: store.id } });

    mockGetCurrentUser.mockResolvedValue({ id: userB.id, email: userB.email, plan: "FREE" });
    const res = await reportGet(req("shared-corpus-store.com"), { params: Promise.resolve({ domain: "shared-corpus-store.com" }) });
    const body = await res.json();
    expect(body.access).toBe("unanalyzed_preview");
  });
});
