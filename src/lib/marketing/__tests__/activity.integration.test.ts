import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getMarketingActivitySummary } from "../activity";

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
    `TRUNCATE "Event","AdObservation","MarketingCollectionRun","Store" RESTART IDENTITY CASCADE`,
  );
});

async function makeStore() {
  return prisma.store.create({ data: { domain: `activity-mkt-${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
}
async function makeRun(storeId: string, startedAt: Date, outcome: "SUCCESS" | "UNAVAILABLE" = "SUCCESS") {
  return prisma.marketingCollectionRun.create({
    data: { storeId, platform: "GOOGLE", startedAt, finishedAt: startedAt, outcome, adsObserved: outcome === "SUCCESS" ? 1 : null },
  });
}
async function makeAdEvent(storeId: string, eventType: "AD_DETECTED" | "AD_REMOVED", occurredAt: Date) {
  return prisma.event.create({
    data: {
      storeId,
      crawlId: null,
      entityType: "AD",
      entityKey: `google:${randomUUID()}`,
      eventType,
      significance: 40,
      headline: "Test ad event",
      dedupeKey: randomUUID(),
      occurredAt,
    },
  });
}
async function makeAdObservation(storeId: string, firstSeenAt: Date, status: "ACTIVE_EVIDENCE" | "HISTORICAL" = "ACTIVE_EVIDENCE") {
  return prisma.adObservation.create({
    data: {
      storeId,
      platform: "GOOGLE",
      externalAdId: randomUUID(),
      status,
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      source: "SERPAPI_GOOGLE_ADS_TRANSPARENCY_CENTER",
    },
  });
}

const NOW = new Date("2026-08-11T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("getMarketingActivitySummary — hasEnoughHistory gating (mirrors monitoring/activity.ts)", () => {
  it("is false with only one successful collection on record — must not fabricate a delta from a single data point", async () => {
    const store = await makeStore();
    await makeRun(store.id, days(1));

    const summary = await getMarketingActivitySummary(prisma, store.id, 30);

    expect(summary.hasEnoughHistory).toBe(false);
  });

  it("is true once a second successful collection exists", async () => {
    const store = await makeStore();
    await makeRun(store.id, days(5));
    await makeRun(store.id, days(1));

    const summary = await getMarketingActivitySummary(prisma, store.id, 30);

    expect(summary.hasEnoughHistory).toBe(true);
  });

  it("a failed (UNAVAILABLE) run does not count toward history — only real successful checks do", async () => {
    const store = await makeStore();
    await makeRun(store.id, days(5), "SUCCESS");
    await makeRun(store.id, days(1), "UNAVAILABLE");

    const summary = await getMarketingActivitySummary(prisma, store.id, 30);

    expect(summary.hasEnoughHistory).toBe(false); // only 1 real success
  });
});

describe("getMarketingActivitySummary — real counts, real window", () => {
  it("counts AD_DETECTED/AD_REMOVED events precisely and excludes anything outside the window", async () => {
    const store = await makeStore();
    await makeRun(store.id, days(40));
    await makeRun(store.id, days(1));

    await makeAdEvent(store.id, "AD_DETECTED", days(10)); // inside 30d window
    await makeAdEvent(store.id, "AD_DETECTED", days(5)); // inside
    await makeAdEvent(store.id, "AD_REMOVED", days(3)); // inside
    await makeAdEvent(store.id, "AD_DETECTED", days(45)); // outside — must not count

    const summary = await getMarketingActivitySummary(prisma, store.id, 30);

    expect(summary.adsDetected).toBe(2);
    expect(summary.adsRemoved).toBe(1);
  });

  it("currentActiveAdCount reflects real ACTIVE_EVIDENCE rows, excluding HISTORICAL ones", async () => {
    const store = await makeStore();
    await makeRun(store.id, days(5));
    await makeRun(store.id, days(1));
    await makeAdObservation(store.id, days(10), "ACTIVE_EVIDENCE");
    await makeAdObservation(store.id, days(10), "ACTIVE_EVIDENCE");
    await makeAdObservation(store.id, days(10), "HISTORICAL");

    const summary = await getMarketingActivitySummary(prisma, store.id, 30);

    expect(summary.currentActiveAdCount).toBe(2);
  });

  it("continuouslyObservedAdCount only counts ads whose firstSeenAt predates the window — a brand-new ad is not 'continuous'", async () => {
    const store = await makeStore();
    await makeRun(store.id, days(60));
    await makeRun(store.id, days(1));
    await makeAdObservation(store.id, days(45)); // first seen BEFORE the 30d window started -> continuous
    await makeAdObservation(store.id, days(5)); // first seen INSIDE the window -> new, not continuous

    const summary = await getMarketingActivitySummary(prisma, store.id, 30);

    expect(summary.currentActiveAdCount).toBe(2);
    expect(summary.continuouslyObservedAdCount).toBe(1);
  });
});
