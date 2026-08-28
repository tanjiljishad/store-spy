import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeStoreSpyUser, resetControlPlane } from "../../test-support/store-spy-user";

/**
 * Regression coverage for a real bug found live during Milestone 12
 * implementation, not a hypothetical: `User.freeTrialEndsAt`'s DB-level
 * default (`(now() + interval '30 days') AT TIME ZONE 'UTC'`) is a
 * genuinely different case from every other `DateTime` default in this
 * schema. Prisma's own `@default(now())` fields (createdAt, etc.) are
 * populated CLIENT-SIDE by Prisma's query engine with an explicit,
 * already-UTC-safe parameter — the engine never actually invokes those
 * columns' SQL-level DEFAULT clause on a real `prisma.user.create()` call.
 * `freeTrialEndsAt` has no client-side special case for `now()`, so its
 * SQL-level DEFAULT genuinely fires on every real insert, which puts it
 * squarely inside AGENTS.md's "Database time rule": a `timestamptz`-typed
 * expression (`now()`) cast into a `timestamp(3)` (no tz) column depends on
 * the session's `TimeZone` GUC, not UTC, unless explicitly wrapped in
 * `AT TIME ZONE 'UTC'`.
 *
 * Caught live against this project's own dev Postgres, whose session
 * TimeZone is Asia/Dhaka (inherited from the host OS — see AGENTS.md's own
 * account of the original incident): a bare `now() + interval '30 days'`
 * default landed exactly 6 hours off from `createdAt + 30 days`. This
 * suite pins a deliberately pathological, fractional-hour session timezone
 * via a dedicated single-connection client so the regression can't survive
 * by coincidence on a CI machine whose Postgres defaults to UTC.
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

// connection_limit=1 pins every query this client makes to the same
// physical connection, so the SET TIME ZONE below reliably applies to
// everything the test does afterward — no pool-routing surprises.
const separator = url.includes("?") ? "&" : "?";
const prisma = new PrismaClient({ datasourceUrl: `${url}${separator}connection_limit=1` });

const PATHOLOGICAL_TZ = "Asia/Kathmandu"; // UTC+5:45 — a fractional offset a lucky hour-rounding bug can't accidentally survive

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE "User" RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`SET TIME ZONE '${PATHOLOGICAL_TZ}'`);
  await resetControlPlane(prisma);
});

describe(`User.freeTrialEndsAt's DB default stays correct under a non-UTC session timezone (${PATHOLOGICAL_TZ})`, () => {
  it("freeTrialEndsAt lands exactly 30.0 days after createdAt — not 30 days plus/minus the session's UTC offset", async () => {
    const before = new Date();
    const user = await makeStoreSpyUser(prisma, { email: `tz-${Date.now()}@example.com` });
    const after = new Date();

    expect(user.freeTrialEndsAt).not.toBeNull();
    const gapMs = user.freeTrialEndsAt!.getTime() - user.createdAt.getTime();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    // A small tolerance for the real (sub-second) gap between the two
    // separately-evaluated `now()` calls inside one INSERT statement —
    // anything beyond a few seconds means the timezone offset leaked in,
    // not measurement noise.
    expect(Math.abs(gapMs - THIRTY_DAYS_MS)).toBeLessThan(5000);

    // createdAt itself must also be real, current UTC time — not shifted.
    expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(user.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("the raw stored value (bypassing Prisma's own Date parsing) is the correct UTC-equivalent wall-clock time, not the session-timezone-local one", async () => {
    const user = await makeStoreSpyUser(prisma, { email: `tz-raw-${Date.now()}@example.com` });

    const rows = await prisma.$queryRaw<{ created_text: string; trial_text: string }[]>`
      SELECT "createdAt"::text as created_text, "freeTrialEndsAt"::text as trial_text
      FROM "User" WHERE id = ${user.id}
    `;
    const { created_text, trial_text } = rows[0];

    // Parse both naive strings as literal UTC (matching how Prisma itself
    // interprets a `timestamp without time zone` value) and compare — the
    // pathological +05:45 offset must not appear anywhere in this diff.
    const createdUtc = new Date(`${created_text.replace(" ", "T")}Z`);
    const trialUtc = new Date(`${trial_text.replace(" ", "T")}Z`);
    const gapDays = (trialUtc.getTime() - createdUtc.getTime()) / (24 * 60 * 60 * 1000);
    expect(gapDays).toBeCloseTo(30, 3);
  });
});
