import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getFunnelCounts } from "../funnel";
import { getCohortRetention } from "../retention";
import { getDailyAnalysesTrend } from "../usage-cost";
import { makeStoreSpyUser, resetControlPlane } from "../../../test-support/store-spy-user";
import { syncControlPlanePlan } from "../../../control-plane/provision";

/**
 * Regression coverage for the exact class of bug AGENTS.md's Database time
 * rule warns about, and this milestone's own task instructions call out by
 * name: "Phase 1 already produced one 6-hour bug from a non-UTC session
 * timezone... this phase is full of date bucketing and is the most likely
 * place for a repeat." See free-trial-default-timezone-safety.integration.test.ts
 * for the original Phase 1 incident this mirrors.
 *
 * Every query in this directory does one of two DIFFERENT things with a
 * timestamp column (see window.ts's header comment for the full reasoning):
 *   1. COMPARE a bound Date parameter against the column (window
 *      boundaries) — must go through utcParam(), or the comparison shifts
 *      by the session's UTC offset.
 *   2. BUCKET the column itself with date_trunc (cohort months, daily
 *      trend) — must NOT be wrapped in AT TIME ZONE 'UTC', or the bucket
 *      boundary shifts by the session's UTC offset instead.
 *
 * Getting rule 2 backwards is the trap: it looks like the "safe" thing to
 * do by analogy with rule 1, and is actually a live regression. This suite
 * pins Asia/Kathmandu (UTC+5:45 — a fractional offset a lucky hour-rounding
 * bug can't accidentally survive) and asserts BOTH rules hold at once,
 * against a real query in this directory, not a synthetic repro.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL unset — run via `npm run test:integration`");
if (!/test/i.test(url)) {
  throw new Error(`Refusing to run: DATABASE_URL does not look like a test database (${url}). This suite TRUNCATEs every table.`);
}

// connection_limit=1, same as free-trial-default-timezone-safety.integration.test.ts —
// pins every query this client makes to one physical connection so SET TIME ZONE reliably applies.
const separator = url.includes("?") ? "&" : "?";
const prisma = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });

const PATHOLOGICAL_TZ = "Asia/Kathmandu"; // UTC+5:45

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "AnonymousAnalysis","Subscription","Watchlist","AnalysisUsage","Session","Account","Store" RESTART IDENTITY CASCADE`,
  );
  await prisma.$executeRawUnsafe(`SET TIME ZONE '${PATHOLOGICAL_TZ}'`);
  await resetControlPlane(prisma);
});

describe(`analytics queries stay UTC-correct under a non-UTC session timezone (${PATHOLOGICAL_TZ})`, () => {
  it("window-boundary comparisons (getFunnelCounts) are not shifted by the session's +05:45 offset", async () => {
    // A signup at 2026-08-07T23:00:00Z is, under +05:45, local wall-clock
    // 2026-08-08T04:45 — still calendar-August-8th in BOTH readings, so
    // this alone wouldn't catch an unwrapped-comparison bug. Pick a value
    // right at the window edge instead: WINDOW_END is 2026-08-08T00:00:00Z.
    // A signup 30 minutes before that boundary must count as INSIDE the
    // window under the correct UTC comparison. Under the broken (session-tz)
    // comparison, the +05:45 offset shifts the effective boundary by nearly
    // 6 hours, which would OUTSIDE-the-window a signup this close to the edge.
    const justInsideWindowEnd = new Date("2026-08-07T23:30:00Z");
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: user.id }, data: { createdAt: justInsideWindowEnd } });

    const windowStart = new Date("2026-08-01T00:00:00Z");
    const windowEnd = new Date("2026-08-08T00:00:00Z");
    const counts = await getFunnelCounts(prisma, windowStart, windowEnd);
    expect(counts.signups).toBe(1);

    // And a signup exactly AT windowEnd must be excluded (half-open [start, end)) — the mirror check.
    const rightAtWindowEnd = new Date("2026-08-08T00:00:00Z");
    const secondUser = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: secondUser.id }, data: { createdAt: rightAtWindowEnd } });
    const countsAfter = await getFunnelCounts(prisma, windowStart, windowEnd);
    expect(countsAfter.signups).toBe(1); // still 1, not 2 — the new row is exactly on the excluded boundary
  });

  it("date_trunc('month', ...) cohort bucketing (getCohortRetention) buckets by the UTC calendar month, not the session-local one", async () => {
    // 2026-08-01T00:00:00Z is midnight UTC on August 1st — the first
    // instant of the UTC month. Under the broken behavior (bucketing a
    // value first converted to timestamptz, which DOES consult session
    // zone), +05:45 local time at that instant is 2026-08-01T05:45, which
    // is STILL August in local terms — not a discriminating case. The
    // discriminating instant is one that's a DIFFERENT calendar month
    // locally than in UTC: 2026-08-01T00:00:00Z minus a few hours would be
    // July in UTC — instead, pick the LAST moment of July in UTC, which
    // under +05:45 local time has already rolled into August.
    const lastMomentOfJulyUtc = new Date("2026-07-31T23:00:00Z"); // local: 2026-08-01T04:45 — August locally, July in UTC
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: user.id }, data: { createdAt: lastMomentOfJulyUtc } });

    const cohorts = await getCohortRetention(prisma, new Date("2026-06-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    const july = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-07-01T00:00:00.000Z");
    const august = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-08-01T00:00:00.000Z");
    expect(july?.cohortSize).toBe(1); // correct: UTC July, regardless of session zone
    expect(august).toBeUndefined(); // the broken behavior would put this user in August instead
  });

  it("currentlyPaid's control-plane period_end comparison (getCohortRetention) is not shifted by the session's +05:45 offset", async () => {
    // B2 2·B commit 3d: currentlyPaid tests `cs.period_end > now` on a bare
    // timestamp(3) column. `now` goes through utcParam() (AGENTS.md rule 1), so
    // the comparison must hold in UTC regardless of session zone. A period_end
    // 30 minutes in the future counts as paid; +05:45 misread would push it
    // ~6h either way and flip the result.
    const soon = new Date(Date.now() + 30 * 60_000);
    const past = new Date(Date.now() - 30 * 60_000);
    const stillPaid = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: stillPaid.id }, data: { createdAt: new Date("2026-07-15T00:00:00Z") } });
    await syncControlPlanePlan(prisma, { userId: stillPaid.id, plan: "BASIC", trialEndsAt: null, paidPeriodEnd: soon });
    const lapsed = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    await prisma.cpUser.update({ where: { id: lapsed.id }, data: { createdAt: new Date("2026-07-15T00:00:00Z") } });
    await syncControlPlanePlan(prisma, { userId: lapsed.id, plan: "BASIC", trialEndsAt: null, paidPeriodEnd: past });

    const cohorts = await getCohortRetention(prisma, new Date("2026-06-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
    const july = cohorts.find((c) => c.cohortMonth.toISOString() === "2026-07-01T00:00:00.000Z")!;
    expect(july.cohortSize).toBe(2);
    expect(july.currentlyPaid).toBe(1); // only `stillPaid` — not shifted by the session zone
  });

  it("date_trunc('day', ...) daily-trend bucketing (getDailyAnalysesTrend) buckets by the UTC calendar day, not the session-local one", async () => {
    // Same discriminating-instant technique, one level down: the last hour
    // of a UTC day, which a +05:45 local reading has already rolled into
    // the next day.
    const lastHourOfAug8Utc = new Date("2026-08-08T23:00:00Z"); // local: 2026-08-09T04:45 — the 9th locally, the 8th in UTC
    const user = await makeStoreSpyUser(prisma, { email: `${randomUUID()}@example.com` });
    const store = await prisma.store.create({ data: { domain: `${randomUUID().slice(0, 8)}.com`, platform: "SHOPIFY" } });
    const row = await prisma.analysisUsage.create({ data: { userId: user.id, storeId: store.id } });
    await prisma.analysisUsage.update({ where: { id: row.id }, data: { createdAt: lastHourOfAug8Utc } });

    const trend = await getDailyAnalysesTrend(prisma, 10, new Date("2026-08-10T00:00:00Z"));
    const point = trend.find((p) => p.count > 0);
    expect(point?.day.toISOString()).toBe("2026-08-08T00:00:00.000Z"); // correct: UTC Aug 8th, not the session-local 9th
  });
});
