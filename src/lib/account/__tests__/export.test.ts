import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PERSONAL_DATA_FIELDS } from "../export";

/**
 * Same DMMF-exhaustiveness pattern as
 * admin/analytics/__tests__/user-export.test.ts, applied to the OPPOSITE
 * direction: that test guards against LEAKING a sensitive field to an
 * admin; this one guards against a new User column silently going
 * UNDISCLOSED in the person's own GDPR Art. 15 export. Both failure modes
 * matter, and both are caught the same way — a field neither exported nor
 * explicitly reviewed fails the test until a human categorizes it.
 */
const REVIEWED_OMITTED_FIELDS = new Set<string>([
  "passwordHash", // a security hash, not meaningfully "about" the person — never returned, even to themselves
  "sessionsValidAfter", // internal JWT-kill-switch bookkeeping, not user-facing account data
  // Relations covered by their OWN top-level section in AccountExportData
  // (watchlists/analysisUsage/subscriptions/checkouts), not the flat
  // `profile` field list this constant selects — genuinely exported, just
  // not through this particular allowlist.
  "accounts",
  "sessions",
  "watchlists",
  "analysisUsage",
  "permissionGrants",
]);

describe("Self-service account export field allowlist", () => {
  it("every field on the Prisma User model is either exported (as a profile field) or explicitly reviewed", () => {
    const userModel = Prisma.dmmf.datamodel.models.find((m) => m.name === "User");
    expect(userModel, "User model not found in Prisma DMMF — has it been renamed?").toBeTruthy();

    const uncategorized = userModel!.fields
      .map((f) => f.name)
      .filter((name) => !(PERSONAL_DATA_FIELDS as readonly string[]).includes(name) && !REVIEWED_OMITTED_FIELDS.has(name));

    expect(uncategorized, "a User field exists that is neither exported nor reviewed — categorize it in export.ts or this test before merging").toEqual([]);
  });

  it("never exports passwordHash", () => {
    expect(PERSONAL_DATA_FIELDS).not.toContain("passwordHash");
  });
});
