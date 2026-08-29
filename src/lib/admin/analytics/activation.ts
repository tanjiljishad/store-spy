import type { PrismaClient } from "@prisma/client";
import { utcParam } from "./window";

/**
 * Milestone 12 §3.1: "% of signups that run an analysis within 24h, and
 * that add a watch within 7 days. If activation is low, pricing is not the
 * problem."
 *
 * B2 2·B commit 3d: the signup cohort comes from `control_plane.users`, not
 * `store_spy.User`. `u."created_at" + interval '24 hours'` is plain arithmetic
 * on a timestamp(3) column — no session-timezone conversion happens (there's
 * no cast to/from timestamptz involved), so this needs no utcParam() wrapping;
 * only the outer window boundary parameters do. See window.ts's header
 * comment for why those are two different rules.
 */
export interface ActivationMetrics {
  windowStart: Date;
  windowEnd: Date;
  signups: number;
  activatedWithin24h: number;
  watchedWithin7d: number;
  activation24hRate: number | null;
  watch7dRate: number | null;
}

export async function getActivationMetrics(prisma: PrismaClient, windowStart: Date, windowEnd: Date): Promise<ActivationMetrics> {
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);

  const rows = await prisma.$queryRaw<{ signups: number; activated_24h: number; watched_7d: number }[]>`
    SELECT
      COUNT(*)::int AS signups,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM "AnalysisUsage" au
          WHERE au."userId" = u.id AND au."createdAt" <= u."created_at" + interval '24 hours'
        )
      )::int AS activated_24h,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM "Watchlist" w
          WHERE w."userId" = u.id AND w."addedAt" <= u."created_at" + interval '7 days'
        )
      )::int AS watched_7d
    FROM "control_plane"."users" u
    WHERE u."created_at" >= ${start} AND u."created_at" < ${end}
  `;

  const { signups, activated_24h, watched_7d } = rows[0];
  return {
    windowStart,
    windowEnd,
    signups,
    activatedWithin24h: activated_24h,
    watchedWithin7d: watched_7d,
    activation24hRate: signups === 0 ? null : activated_24h / signups,
    watch7dRate: signups === 0 ? null : watched_7d / signups,
  };
}
