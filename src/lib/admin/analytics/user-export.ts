import type { PrismaClient } from "@prisma/client";
import type { PlanTier } from "../../entitlements/plan-limits";
import type { Role } from "../roles";
import { buildUserSearchWhere, type UserSearchFilters } from "../users-service";
import { recordAdminAction } from "../audit";
import type { AdminActor } from "../guard";

/**
 * Milestone 12 Section 3.3: "POST /api/admin/users/export requires
 * export:users (NOT user:read) — bulk export is a materially different act
 * from looking someone up... Excludes passwordHash, session tokens, and all
 * integration credentials."
 *
 * USER_EXPORT_SELECT_FIELDS is the actual, single allowlist the query
 * below selects — user-export.test.ts asserts EVERY field on the Prisma
 * User model (via Prisma.dmmf, no DB needed) is either in this list or in
 * that test's own REVIEWED_NON_EXPORTED_FIELDS set, so a new column added
 * to the schema later fails that test until a human categorizes it. That's
 * the actual enforcement mechanism the doc asks for ("fails if a new
 * sensitive User column is ever added without being excluded") — this
 * allowlist alone is just data the test reads.
 *
 * Session tokens live on the separate Session model, never a User column —
 * satisfied structurally by this query never joining Session/Account, not
 * by an entry in this list. Integration credentials don't exist yet
 * (Phase 4's IntegrationCredential model) — nothing to exclude today.
 */
export const USER_EXPORT_SELECT_FIELDS = ["id", "email", "plan", "role", "createdAt"] as const;
export type UserExportField = (typeof USER_EXPORT_SELECT_FIELDS)[number];

export interface UserExportRow {
  id: string;
  email: string;
  plan: PlanTier;
  role: Role;
  createdAt: string;
}

export async function exportUsers(
  prisma: PrismaClient,
  filters: Pick<UserSearchFilters, "emailQuery" | "plan" | "role"> = {},
  opts: { marketingConsentOnly?: boolean } = {},
): Promise<UserExportRow[]> {
  const where = buildUserSearchWhere(filters);
  const rows = await prisma.cpUser.findMany({
    // Milestone 12 §4.1: "purpose: 'marketing' returns only consented
    // users." A plain AND onto the same where clause every other filter
    // already goes through — never a separate query path a future filter
    // change could apply to one purpose and forget the other. B2 2·B commit
    // 3a: consent is the store_spy.MarketingConsent join, not a User column.
    where: opts.marketingConsentOnly ? { ...where, marketingConsent: { is: { consent: true } } } : where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      email: true,
      createdAt: true,
      adminRole: { select: { role: true } },
      account: {
        select: {
          subscriptions: { where: { status: { in: ["ACTIVE", "TRIALING"] } }, select: { planSlug: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    plan: (r.account.subscriptions[0]?.planSlug as PlanTier | undefined) ?? "FREE",
    role: r.adminRole?.role ?? "USER",
    createdAt: r.createdAt.toISOString(),
  }));
}

// A value starting with any of these is a live formula in Excel/Sheets when
// the CSV is opened there — RFC 4180 quoting alone does not neutralize it
// (a quoted field starting with `=` still evaluates). `isPlausibleEmail`
// (normalize-email.ts) permits `=`/`+`/`-`/`@` in the local part and is
// deliberately NOT being tightened to reject them — those are legal RFC
// 5322 local-part characters, and OAuth-sourced emails aren't even
// validated against that regex at all, so an email-shaped allowlist could
// never be a complete fix. This is the correct layer: neutralize at the
// one place these values actually become formulas, not at every place a
// string might end up here.
//
// The guard is NOT invisible: the leading `'` becomes part of the exported
// value itself, not a display-only artifact Excel/Sheets strips on the way
// in — a program parsing this CSV programmatically sees the literal string
// `'=foo@bar.com`, not `=foo@bar.com`. Deliberate and fine for this export's
// actual consumer (a human opening it in a spreadsheet); do not "clean up"
// this leading quote later without re-solving formula injection some other
// way first.
const DANGEROUS_PREFIX_RE = /^[=+\-@\t\r]/;
// \r is included even though it can't start a *quoted* field meaningfully
// on its own — a bare CR embedded mid-value can still be read as a row
// terminator by a lenient parser, so any occurrence (not just a leading
// one) forces quoting, same as \n and , already did.
const NEEDS_QUOTING_RE = /["\n,\r]/;

export function csvEscape(value: string): string {
  const dangerous = DANGEROUS_PREFIX_RE.test(value);
  const guarded = dangerous ? `'${value}` : value;
  if (dangerous || NEEDS_QUOTING_RE.test(value)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

/** RFC 4180-ish CSV — the export's actual wire format (Content-Type: text/csv on the route). */
export function toCsv(rows: UserExportRow[]): string {
  const header = USER_EXPORT_SELECT_FIELDS.join(",");
  const lines = rows.map((r) => USER_EXPORT_SELECT_FIELDS.map((field) => csvEscape(String(r[field]))).join(","));
  return [header, ...lines].join("\n");
}

export type ExportPurpose = "support" | "marketing";

export type ExportUsersOutcome = { outcome: "exported"; rows: UserExportRow[] };

/**
 * Milestone 12 Section 4.1 / Section 3.3: "An export flagged purpose:
 * 'marketing' returns only consented users. An export flagged purpose:
 * 'support' may include all, and is audited more loudly." Phase 3 shipped
 * this with `purpose:"marketing"` hard-failing 501 — `User.marketingConsent`
 * didn't exist yet, and exporting unconsented users would have been exactly
 * the harm §4.1 exists to prevent. Now that the column and its regression
 * coverage exist (see marketing/consent.ts, the signup route, and this
 * file's own integration test asserting an unconsented user never appears
 * in a marketing-purpose export), this filters on `marketingConsent = true`
 * instead of refusing outright.
 *
 * The audit write happens BEFORE this function returns the exported rows —
 * if it throws, the caller never gets data back. Same "an action that
 * can't be logged never silently happens" discipline audit.ts's own doc
 * comment states for mutations, applied here to a read: a bulk export with
 * no audit trail is the one thing the doc calls out as needing to be
 * "audited more loudly" than a lookup.
 *
 * §4.1 addendum: `filters.emailQuery` is a raw admin-typed search string
 * that CAN be a specific person's full email address — recording it
 * verbatim in `metadata` would embed that person's PII in a row with no
 * single `targetId` to later tombstone (a bulk export targets a query, not
 * one user). Recorded as a boolean instead — "an email filter was applied"
 * is real, useful audit signal; the string itself is not needed to
 * reconstruct what happened, and never persisted.
 */
export async function exportUsersWithAudit(
  prisma: PrismaClient,
  actor: AdminActor,
  filters: Pick<UserSearchFilters, "emailQuery" | "plan" | "role">,
  purpose: ExportPurpose,
): Promise<ExportUsersOutcome> {
  const rows = await exportUsers(prisma, filters, { marketingConsentOnly: purpose === "marketing" });
  const { emailQuery, ...nonPiiFilters } = filters;
  await recordAdminAction(prisma, {
    actorId: actor.id,
    actorEmail: actor.email,
    action: "user.export",
    targetType: "User",
    metadata: { rowCount: rows.length, filters: { ...nonPiiFilters, hasEmailFilter: Boolean(emailQuery) }, purpose },
  });
  return { outcome: "exported", rows };
}
