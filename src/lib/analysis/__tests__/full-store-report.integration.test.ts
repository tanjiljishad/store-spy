import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildFullStoreReport } from "../run-analysis";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/**
 * Milestone 7 Sub-phase B, Finding 1: pixels and payment providers were
 * fully detected/persisted/historized but never surfaced in any report.
 * Direct tests of buildFullStoreReport() (not routed through a full crawl
 * fixture) so this isolates the new query/field logic precisely — see
 * run-analysis.integration.test.ts for the full crawl-pipeline coverage
 * that already exercises `apps` end to end.
 */

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
    `TRUNCATE "AnalysisUsage","Event","ProductStateSnapshot","Product","StoreEntity","Crawl","StoreStats","Watchlist","Store" RESTART IDENTITY CASCADE`,
  );
  await resetControlPlane(prisma);
});

async function makeStoreAndUser(domain: string) {
  const store = await prisma.store.create({ data: { domain, platform: "SHOPIFY", themeName: "Dawn" } });
  const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com`, plan: "FREE" });
  return { store, user };
}

describe("buildFullStoreReport — pixels and payment providers", () => {
  it("surfaces pixels and payment providers as their own OBSERVED fields, distinct from apps", async () => {
    const { store, user } = await makeStoreAndUser("pixel-test.com");

    await prisma.storeEntity.createMany({
      data: [
        { storeId: store.id, kind: "APP", key: "klaviyo", status: "ACTIVE" },
        { storeId: store.id, kind: "PIXEL", key: "facebook", status: "ACTIVE", meta: { id: "123456" } },
        { storeId: store.id, kind: "PIXEL", key: "ga4", status: "ACTIVE" },
        { storeId: store.id, kind: "PAYMENT_PROVIDER", key: "shop_pay", status: "ACTIVE" },
        { storeId: store.id, kind: "COLLECTION", key: "all", status: "ACTIVE" },
      ],
    });

    const report = await buildFullStoreReport(prisma, store.id, store.domain, user.id, false);

    expect(report.apps).toEqual({ status: "OBSERVED", value: ["klaviyo"] });
    expect(report.pixels.status).toBe("OBSERVED");
    if (report.pixels.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.pixels.value.sort()).toEqual(["facebook", "ga4"]);
    expect(report.paymentProviders).toEqual({ status: "OBSERVED", value: ["shop_pay"] });
  });

  it("returns an OBSERVED empty array — not UNAVAILABLE — when no pixels/payment providers are detected", async () => {
    const { store, user } = await makeStoreAndUser("no-pixels.com");

    const report = await buildFullStoreReport(prisma, store.id, store.domain, user.id, false);

    expect(report.pixels).toEqual({ status: "OBSERVED", value: [] });
    expect(report.paymentProviders).toEqual({ status: "OBSERVED", value: [] });
  });

  it("excludes MISSING/REMOVED pixels and payment providers — only currently-ACTIVE ones are reported", async () => {
    const { store, user } = await makeStoreAndUser("removed-pixel.com");

    await prisma.storeEntity.createMany({
      data: [
        { storeId: store.id, kind: "PIXEL", key: "facebook", status: "ACTIVE" },
        { storeId: store.id, kind: "PIXEL", key: "tiktok", status: "REMOVED", missingSince: new Date() },
      ],
    });

    const report = await buildFullStoreReport(prisma, store.id, store.domain, user.id, false);

    if (report.pixels.status !== "OBSERVED") throw new Error("unreachable");
    expect(report.pixels.value).toEqual(["facebook"]);
  });
});
