import type { PrismaClient } from "@prisma/client";
import { utcParam } from "./window";

/**
 * Milestone 12 §3.1: "signup-cohort retention by month; trial->paid
 * conversion rate by cohort. Cohort tables are the only honest way to see
 * whether the product is improving or the top of funnel is just growing."
 *
 * `date_trunc('month', u."createdAt")` buckets the bare timestamp(3)
 * column directly — no utcParam() here, only on the two window-boundary
 * parameters. See window.ts's header comment for why those are opposite
 * rules; this module (a GROUP BY date_trunc) is exactly the case that
 * comment warns against getting backwards.
 *
 * This schema has no login/session-activity timestamps beyond auth, so a
 * full month-by-month "% still active" retention CURVE (M0, M1, M2, ...)
 * isn't something this data can honestly support — it would have to define
 * "active" as "still on a paid plan," which collapses to the same signal
 * as trial->paid conversion. Rather than fabricate a curve, this reports
 * two honestly-distinct, cohort-grouped numbers:
 *   - everPaid: % of the cohort that has EVER held a Subscription (paid at
 *     least once, even if they've since churned back to FREE) — the
 *     trial->paid conversion rate the doc asks for.
 *   - currentlyPaid: % of the cohort whose CURRENT plan is non-FREE right
 *     now — a point-in-time retained-paying fraction, the closest honest
 *     analog to "retention" this schema can produce.
 */
export interface CohortRow {
  cohortMonth: Date;
  cohortSize: number;
  everPaid: number;
  currentlyPaid: number;
  everPaidRate: number | null;
  currentlyPaidRate: number | null;
}

export async function getCohortRetention(prisma: PrismaClient, windowStart: Date, windowEnd: Date): Promise<CohortRow[]> {
  const start = utcParam(windowStart);
  const end = utcParam(windowEnd);

  const rows = await prisma.$queryRaw<{ cohort_month: Date; cohort_size: number; ever_paid: number; currently_paid: number }[]>`
    SELECT
      date_trunc('month', u."createdAt") AS cohort_month,
      COUNT(*)::int AS cohort_size,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Subscription" s WHERE s."userId" = u.id))::int AS ever_paid,
      COUNT(*) FILTER (WHERE u.plan != 'FREE')::int AS currently_paid
    FROM "User" u
    WHERE u."createdAt" >= ${start} AND u."createdAt" < ${end}
    GROUP BY 1
    ORDER BY 1
  `;

  return rows.map((r) => ({
    cohortMonth: r.cohort_month,
    cohortSize: r.cohort_size,
    everPaid: r.ever_paid,
    currentlyPaid: r.currently_paid,
    everPaidRate: r.cohort_size === 0 ? null : r.ever_paid / r.cohort_size,
    currentlyPaidRate: r.cohort_size === 0 ? null : r.currently_paid / r.cohort_size,
  }));
}
