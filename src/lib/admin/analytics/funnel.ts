import type { PrismaClient } from "@prisma/client";
import { utcParam } from "./window";

/**
 * Milestone 12 §3.1: "anonymous analysis -> signup -> first analysis ->
 * first watch -> paid. Absolute counts and conversion rate per step, over a
 * selectable window."
 *
 * This reports independent per-step COUNTS within the window, not a
 * per-identity attribution chain — an anonymous probe (AnonymousAnalysis)
 * is keyed only on IP, never linked to the User row a visitor may later
 * create (no such link exists anywhere in the schema, deliberately: an
 * anonymous probe creates no Store row and no session), so "this specific
 * anonymous visitor became this specific signup" is not a question this
 * schema can answer. What IS answerable, and is what a funnel dashboard is
 * actually used for, is "how many at each step, and what fraction of the
 * step before it" — the doc's own "absolute counts and conversion rate"
 * phrasing matches this reading. computeFunnelSteps() (Prisma-free, unit
 * tested) turns the raw counts into that ordered, rate-annotated shape.
 *
 * "paid" counts a user's FIRST-EVER Subscription row starting in the
 * window, any source — PROMO, PROVIDER, or MANUAL — since the funnel
 * question is "did this cohort convert at all," not "did they pay with a
 * card" (that promo-vs-paid distinction is revenue.ts's job).
 */
export interface FunnelCounts {
  windowStart: Date;
  windowEnd: Date;
  anonymousAnalyses: number;
  signups: number;
  firstAnalyses: number;
  firstWatches: number;
  firstPaidConversions: number;
}

export async function getFunnelCounts(prisma: PrismaClient, windowStart: Date, windowEnd: Date): Promise<FunnelCounts> {
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);

  const [anon, signup, firstAnalysis, firstWatch, firstPaid] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "AnonymousAnalysis"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM "User"
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM (
        SELECT "userId", MIN("createdAt") AS first_at FROM "AnalysisUsage" GROUP BY "userId"
      ) t WHERE first_at >= ${start} AND first_at < ${end}
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM (
        SELECT "userId", MIN("addedAt") AS first_at FROM "Watchlist" GROUP BY "userId"
      ) t WHERE first_at >= ${start} AND first_at < ${end}
    `,
    prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM (
        SELECT "userId", MIN("startedAt") AS first_at FROM "Subscription" GROUP BY "userId"
      ) t WHERE first_at >= ${start} AND first_at < ${end}
    `,
  ]);

  return {
    windowStart,
    windowEnd,
    anonymousAnalyses: anon[0].n,
    signups: signup[0].n,
    firstAnalyses: firstAnalysis[0].n,
    firstWatches: firstWatch[0].n,
    firstPaidConversions: firstPaid[0].n,
  };
}

export interface FunnelStep {
  key: "anonymous_analysis" | "signup" | "first_analysis" | "first_watch" | "paid";
  label: string;
  count: number;
  /** Fraction of the PREVIOUS step's count that reached this one. Null for the first step, and when the previous step's count is 0 (division is undefined, not 0%). */
  conversionFromPrevious: number | null;
}

const STEP_DEFS: Array<{ key: FunnelStep["key"]; label: string; pick: (c: FunnelCounts) => number }> = [
  { key: "anonymous_analysis", label: "Anonymous analysis", pick: (c) => c.anonymousAnalyses },
  { key: "signup", label: "Signup", pick: (c) => c.signups },
  { key: "first_analysis", label: "First analysis", pick: (c) => c.firstAnalyses },
  { key: "first_watch", label: "First watch", pick: (c) => c.firstWatches },
  { key: "paid", label: "Paid", pick: (c) => c.firstPaidConversions },
];

/** Prisma-free — pure formatting/rate math, unit-tested with no DB (funnel.test.ts). */
export function computeFunnelSteps(counts: FunnelCounts): FunnelStep[] {
  return STEP_DEFS.map((def, i) => {
    const count = def.pick(counts);
    if (i === 0) return { key: def.key, label: def.label, count, conversionFromPrevious: null };
    const previousCount = STEP_DEFS[i - 1].pick(counts);
    return {
      key: def.key,
      label: def.label,
      count,
      conversionFromPrevious: previousCount === 0 ? null : count / previousCount,
    };
  });
}
