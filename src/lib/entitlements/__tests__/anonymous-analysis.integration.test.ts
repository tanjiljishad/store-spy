import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { countAnonymousAnalysesInWindow, recordAnonymousAnalysis, sweepOldAnonymousAnalyses } from "../anonymous-analysis";
import { getClientIp } from "../../security/rate-limit";

/**
 * Milestone 12 §1.3: the DB-backed ledger behind the anonymous 3/24h quota
 * and the global hourly circuit breaker. Run via `npm run test:integration`
 * — see persist.integration.test.ts for why DATABASE_URL is guarded this
 * way (this suite truncates the table).
 */

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) throw new Error("Run this destructive suite with npm run test:integration against the test database.");
const prisma = new PrismaClient();
afterAll(async () => prisma.$disconnect());
beforeEach(async () => prisma.$executeRawUnsafe(`TRUNCATE "AnonymousAnalysis" RESTART IDENTITY CASCADE`));

const HIGH_CEILING = 1000; // effectively "the circuit breaker never trips" for tests not exercising it directly

describe("anonymous analysis quota — 3 per rolling 24h per IP", () => {
  it("Phase 1 acceptance criterion: the 4th anonymous analysis from one IP in 24h is rejected; the 1st-3rd succeed", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await recordAnonymousAnalysis(prisma, "203.0.113.5", `store-${i}.com`, HIGH_CEILING);
      expect(result.outcome).toBe("recorded");
    }

    const fourth = await recordAnonymousAnalysis(prisma, "203.0.113.5", "store-3.com", HIGH_CEILING);
    expect(fourth).toMatchObject({ outcome: "limit_reached", current: 3, max: 3 });
    if (fourth.outcome !== "limit_reached") throw new Error("unreachable");
    expect(fourth.resetsAt).not.toBeNull();

    expect(await prisma.anonymousAnalysis.count({ where: { ipKey: "203.0.113.5" } })).toBe(3);
  });

  // Phase 1 acceptance criterion, verbatim: "a spoofed x-forwarded-for does
  // not reset it (regression test against fix 1.1)." Exercised here at the
  // ACTUAL ledger boundary — getClientIp() extracts the same real ipKey
  // from a clean header and a spoofed-prefix one, so both requests land in
  // the SAME bucket rather than the attacker minting a fresh one per prefix.
  it("regression against fix 1.1: a spoofed x-forwarded-for prefix resolves to the SAME ipKey, so it cannot reset the quota", async () => {
    const clean = getClientIp(new Headers({ "x-forwarded-for": "203.0.113.5" }));
    const spoofed1 = getClientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" }));
    const spoofed2 = getClientIp(new Headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.5" }));
    expect(clean).toBe(spoofed1);
    expect(spoofed1).toBe(spoofed2);

    // Burn all 3 slots, each request "arriving" with a DIFFERENT spoofed
    // prefix — if the pre-fix behavior (trusting the first XFF entry) were
    // in play here, each of these would look like a distinct IP and mint
    // its own fresh 3-request bucket.
    await recordAnonymousAnalysis(prisma, clean, "a.com", HIGH_CEILING);
    await recordAnonymousAnalysis(prisma, spoofed1, "b.com", HIGH_CEILING);
    await recordAnonymousAnalysis(prisma, spoofed2, "c.com", HIGH_CEILING);

    const fourth = await recordAnonymousAnalysis(prisma, getClientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.5" })), "d.com", HIGH_CEILING);
    expect(fourth.outcome).toBe("limit_reached");
  });

  it("different real IPs get independent buckets", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await recordAnonymousAnalysis(prisma, "203.0.113.5", `x-${i}.com`, HIGH_CEILING)).outcome).toBe("recorded");
    }
    // A genuinely different IP is unaffected.
    expect((await recordAnonymousAnalysis(prisma, "198.51.100.9", "y.com", HIGH_CEILING)).outcome).toBe("recorded");
  });

  it("two concurrent requests from the same IP with exactly one slot left produce exactly one recorded outcome", async () => {
    await recordAnonymousAnalysis(prisma, "203.0.113.9", "first.com", HIGH_CEILING);
    await recordAnonymousAnalysis(prisma, "203.0.113.9", "second.com", HIGH_CEILING);

    const [a, b] = await Promise.all([
      recordAnonymousAnalysis(prisma, "203.0.113.9", "third.com", HIGH_CEILING),
      recordAnonymousAnalysis(prisma, "203.0.113.9", "fourth.com", HIGH_CEILING),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["limit_reached", "recorded"]);
    expect(await prisma.anonymousAnalysis.count({ where: { ipKey: "203.0.113.9" } })).toBe(3);
  });

  it("countAnonymousAnalysesInWindow reports the real count for an IP", async () => {
    expect(await countAnonymousAnalysesInWindow(prisma, "203.0.113.20")).toBe(0);
    await recordAnonymousAnalysis(prisma, "203.0.113.20", "one.com", HIGH_CEILING);
    expect(await countAnonymousAnalysesInWindow(prisma, "203.0.113.20")).toBe(1);
  });

  it("a request older than 24h falls out of the window and frees a slot", async () => {
    await recordAnonymousAnalysis(prisma, "203.0.113.30", "old.com", HIGH_CEILING);
    await prisma.anonymousAnalysis.updateMany({
      where: { ipKey: "203.0.113.30" },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    expect(await countAnonymousAnalysesInWindow(prisma, "203.0.113.30")).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect((await recordAnonymousAnalysis(prisma, "203.0.113.30", `fresh-${i}.com`, HIGH_CEILING)).outcome).toBe("recorded");
    }
  });
});

describe("global hourly circuit breaker", () => {
  it("blocks a request once the global count in the last hour reaches the ceiling, regardless of that IP's own quota", async () => {
    const ceiling = 5;
    for (let i = 0; i < ceiling; i++) {
      // Every request from a DIFFERENT IP — proving this is a global,
      // not per-IP, ceiling.
      const result = await recordAnonymousAnalysis(prisma, `203.0.113.${i}`, `s-${i}.com`, ceiling);
      expect(result.outcome).toBe("recorded");
    }

    const overCeiling = await recordAnonymousAnalysis(prisma, "203.0.113.250", "s-over.com", ceiling);
    expect(overCeiling.outcome).toBe("circuit_open");
  });

  it("only counts the last hour, not the full 24h quota window", async () => {
    const ceiling = 2;
    await recordAnonymousAnalysis(prisma, "203.0.113.1", "recent.com", ceiling);
    // A row from 2 hours ago is outside the circuit breaker's 1h window
    // even though it's well inside the 24h per-IP quota window.
    await prisma.anonymousAnalysis.create({ data: { ipKey: "203.0.113.2", domain: "old.com", createdAt: new Date(Date.now() - 2 * 60 * 60_000) } });

    const result = await recordAnonymousAnalysis(prisma, "203.0.113.3", "fresh.com", ceiling);
    expect(result.outcome).toBe("recorded"); // only 1 row (recent.com) counted toward the ceiling of 2
  });
});

describe("sweepOldAnonymousAnalyses", () => {
  it("deletes rows older than 48h and leaves recent ones intact", async () => {
    await recordAnonymousAnalysis(prisma, "203.0.113.40", "recent.com", HIGH_CEILING);
    await prisma.anonymousAnalysis.create({ data: { ipKey: "203.0.113.41", domain: "ancient.com", createdAt: new Date(Date.now() - 49 * 60 * 60_000) } });

    const result = await sweepOldAnonymousAnalyses(prisma);
    expect(result.deletedCount).toBe(1);
    expect(await prisma.anonymousAnalysis.count()).toBe(1);
    expect((await prisma.anonymousAnalysis.findFirstOrThrow()).domain).toBe("recent.com");
  });
});
