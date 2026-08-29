import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PERSONAL_DATA_FIELDS } from "../export";

/**
 * Same DMMF-exhaustiveness pattern as
 * admin/analytics/__tests__/user-export.test.ts, applied to the OPPOSITE
 * direction: that test guards against LEAKING a sensitive field to an admin;
 * this one guards against a new user-identity column silently going UNDISCLOSED
 * in the person's own GDPR Art. 15 export. Both failure modes matter, and both
 * are caught the same way — a column neither exported nor explicitly reviewed
 * fails the test until a human categorizes it.
 *
 * B2 2·B step 4: `store_spy.User` is gone. User-identity data now spans three
 * Prisma models — `CpUser` (control_plane.users) + the `store_spy` companions
 * `UserAdminRole` and `MarketingConsent`. This walks all three.
 */
const IDENTITY_MODELS = ["CpUser", "UserAdminRole", "MarketingConsent"] as const;

/** The column names exportOwnAccountData() reads into the `profile` block (some renamed on the way out — see the comments). */
const EXPORTED_COLUMNS = new Set<string>([
  "id",
  "email",
  "emailVerifiedAt", // -> profile.emailVerified
  "name",
  "image",
  "tosAcceptedAt",
  "createdAt",
  "updatedAt",
  "role", // UserAdminRole.role -> profile.role
  "consent", // MarketingConsent.consent -> profile.marketingConsent
  "consentAt", // -> profile.marketingConsentAt
  "consentSource", // -> profile.marketingConsentSource
]);

const REVIEWED_OMITTED_COLUMNS = new Set<string>([
  "passwordHash", // a security hash, not meaningfully "about" the person — never returned, even to themselves
  "sessionsValidAfter", // internal JWT-kill-switch bookkeeping, not user-facing account data
  "accountId", // internal control_plane FK; the account carries no user-facing data beyond what profile already has
  "accountRole", // billing OWNER/MEMBER role — always OWNER for a single-user account; not the admin `role`, which IS exported
  "userId", // the companion tables' PK — identical to `id`, already exported
]);

/** Scalar (non-relation) field names across the three identity models, deduped. */
function identityScalarColumns(): string[] {
  const names = new Set<string>();
  for (const modelName of IDENTITY_MODELS) {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    expect(model, `${modelName} not found in Prisma DMMF — has it been renamed?`).toBeTruthy();
    for (const f of model!.fields) {
      if (f.kind !== "object") names.add(f.name); // skip relation fields
    }
  }
  return [...names];
}

describe("Self-service account export field allowlist", () => {
  it("every user-identity column (CpUser + UserAdminRole + MarketingConsent) is either exported or explicitly reviewed", () => {
    const uncategorized = identityScalarColumns().filter(
      (name) => !EXPORTED_COLUMNS.has(name) && !REVIEWED_OMITTED_COLUMNS.has(name),
    );
    expect(
      uncategorized,
      "a user-identity column is neither exported nor reviewed — categorize it in export.ts or this test before merging",
    ).toEqual([]);
  });

  it("the derived (non-column) profile keys are covered by PERSONAL_DATA_FIELDS", () => {
    // `plan` (from getPurchasedPlanSlug) and `freeTrialEndsAt` (from the subt_
    // subscription's period_end) aren't columns of any identity model — they're
    // derived — but they ARE disclosed, so the output allowlist must name them.
    expect(PERSONAL_DATA_FIELDS).toContain("plan");
    expect(PERSONAL_DATA_FIELDS).toContain("freeTrialEndsAt");
  });

  it("never exports passwordHash", () => {
    expect(PERSONAL_DATA_FIELDS).not.toContain("passwordHash");
  });
});
