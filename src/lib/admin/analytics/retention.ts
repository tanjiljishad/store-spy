import type { PrismaClient } from "@prisma/client";
import { utcParam } from "./window";

/**
 * Milestone 12 §3.1: "signup-cohort retention by month; trial->paid
 * conversion rate by cohort. Cohort tables are the only honest way to see
 * whether the product is improving or the top of funnel is just growing."
 *
 * B2 2·B commit 3d: the cohort and `currentlyPaid` both come from the control
 * plane now. `date_trunc('month', u."created_at")` buckets the bare
 * timestamp(3) column directly — no utcParam() here, only on the two
 * window-boundary parameters. See window.ts's header comment for why those are
 * opposite rules; this module (a GROUP BY date_trunc) is exactly the case that
 * comment warns against getting backwards.
 *
 * `currentlyPaid` asks a CURRENTLY-PAYING question, so it does NOT just test
 * `plan_slug != 'FREE'` — `plan_slug` is the tier the account BOUGHT, and a
 * churned account whose paid period lapsed but which the subscription sweep
 * hasn't demoted yet still carries `plan_slug = 'BASIC'`. It tests for an
 * ACTIVE control-plane subscription, non-FREE, whose `period_end` is null or
 * in the future — the same "active and not expired" condition
 * resolveEntitlement() itself applies. `everPaid` is unchanged: it reads the
 * legacy billing-history `store_spy.Subscription` table (not migrated in B2).
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
  const now = utcParam(new Date());

  const rows = await prisma.$queryRaw<{ cohort_month: Date; cohort_size: number; ever_paid: number; currently_paid: number }[]>`
    SELECT
      date_trunc('month', u."created_at") AS cohort_month,
      COUNT(*)::int AS cohort_size,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Subscription" s WHERE s."userId" = u.id))::int AS ever_paid,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "control_plane"."subscriptions" cs
        WHERE cs."account_id" = 'acct_' || u.id
          AND cs.status = 'ACTIVE'
          AND cs.plan_slug <> 'FREE'
          AND (cs.period_end IS NULL OR cs.period_end > ${now})
      ))::int AS currently_paid
    FROM "control_plane"."users" u
    WHERE u."created_at" >= ${start} AND u."created_at" < ${end}
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
