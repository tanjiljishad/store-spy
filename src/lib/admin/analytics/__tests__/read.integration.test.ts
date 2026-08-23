import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDailyTrend, getLatestPointInTimeSnapshot, getLatestSnapshot, getRetentionCohorts } from "../read";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "MetricSnapshot" RESTART IDENTITY CASCADE`));

describe("getLatestSnapshot", () => {
  it("returns one row per dimension, the freshest windowEnd per dimension", async () => {
    await prisma.metricSnapshot.create({
      data: { metricKey: "revenue.mrr_cents:30d", dimension: "BASIC", windowStart: new Date("2026-08-01T00:00:00Z"), windowEnd: new Date("2026-08-21T13:00:00Z"), value: 1900 },
    });
    // A stale row for the same dimension that pruning missed (defense in depth for the read side) — must not be returned.
    await prisma.metricSnapshot.create({
      data: { metricKey: "revenue.mrr_cents:30d", dimension: "BASIC", windowStart: new Date("2026-08-01T00:00:00Z"), windowEnd: new Date("2026-08-21T12:00:00Z"), value: 999999 },
    });
    await prisma.metricSnapshot.create({
      data: { metricKey: "revenue.mrr_cents:30d", dimension: "BUSINESS", windowStart: new Date("2026-08-01T00:00:00Z"), windowEnd: new Date("2026-08-21T13:00:00Z"), value: 4900 },
    });

    const points = await getLatestSnapshot(prisma, "revenue.mrr_cents", "30d");
    expect(points).toHaveLength(2);
    const basic = points.find((p) => p.dimension === "BASIC");
    expect(basic?.value).toBe(1900);
  });
});

describe("getLatestPointInTimeSnapshot", () => {
  it("returns the most recent row for a point-in-time metric", async () => {
    await prisma.metricSnapshot.create({
      data: { metricKey: "operational.scheduler_lag", dimension: "", windowStart: new Date("2026-08-21T12:00:00Z"), windowEnd: new Date("2026-08-21T12:00:00Z"), value: 3 },
    });
    await prisma.metricSnapshot.create({
      data: { metricKey: "operational.scheduler_lag", dimension: "", windowStart: new Date("2026-08-21T13:00:00Z"), windowEnd: new Date("2026-08-21T13:00:00Z"), value: 7 },
    });

    const point = await getLatestPointInTimeSnapshot(prisma, "operational.scheduler_lag");
    expect(point?.value).toBe(7);
  });

  it("returns null when the metric has never been computed", async () => {
    expect(await getLatestPointInTimeSnapshot(prisma, "operational.scheduler_lag")).toBeNull();
  });
});

describe("getDailyTrend", () => {
  it("returns points within the trailing N days, oldest first", async () => {
    await prisma.metricSnapshot.create({
      data: { metricKey: "usage_cost.analyses_per_day", dimension: "FREE", windowStart: new Date("2026-08-19T00:00:00Z"), windowEnd: new Date("2026-08-20T00:00:00Z"), value: 5 },
    });
    await prisma.metricSnapshot.create({
      data: { metricKey: "usage_cost.analyses_per_day", dimension: "FREE", windowStart: new Date("2026-08-20T00:00:00Z"), windowEnd: new Date("2026-08-21T00:00:00Z"), value: 8 },
    });

    const trend = await getDailyTrend(prisma, "usage_cost.analyses_per_day", 7, new Date("2026-08-21T15:00:00Z"));
    expect(trend.map((p) => p.value)).toEqual([5, 8]);
  });
});

describe("getRetentionCohorts", () => {
  it("joins cohort_size/ever_paid/currently_paid rows by their shared windowStart", async () => {
    const cohortMonth = new Date("2026-07-01T00:00:00Z");
    const monthEnd = new Date("2026-08-01T00:00:00Z");
    await prisma.metricSnapshot.create({ data: { metricKey: "retention.cohort_size", windowStart: cohortMonth, windowEnd: monthEnd, value: 10 } });
    await prisma.metricSnapshot.create({ data: { metricKey: "retention.ever_paid", windowStart: cohortMonth, windowEnd: monthEnd, value: 3 } });
    await prisma.metricSnapshot.create({ data: { metricKey: "retention.currently_paid", windowStart: cohortMonth, windowEnd: monthEnd, value: 2 } });

    const cohorts = await getRetentionCohorts(prisma);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toMatchObject({ cohortSize: 10, everPaid: 3, currentlyPaid: 2 });
  });
});
