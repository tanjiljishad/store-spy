import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { USER_EXPORT_SELECT_FIELDS, csvEscape, toCsv, type UserExportRow } from "../user-export";

/**
 * Milestone 12 Section 3.3: "Assert this in a test that fails if a new
 * sensitive user column is ever added without being excluded." Reads the models
 * straight from Prisma's DMMF (no DB connection — schema metadata baked into the
 * generated client) rather than hand-copying schema.prisma's field list, so it
 * can't silently drift. Every column must be explicitly categorized: exported,
 * or in REVIEWED_NON_EXPORTED_COLUMNS below with a human having confirmed it
 * isn't a secret. A brand-new column lands in NEITHER set and fails this test.
 *
 * B2 2·B step 4: `store_spy.User` is gone. User-identity data spans three Prisma
 * models — `CpUser` + `UserAdminRole` + `MarketingConsent`. This walks all three.
 */
const IDENTITY_MODELS = ["CpUser", "UserAdminRole", "MarketingConsent"] as const;

/** Columns this support CSV actually emits (`plan` is a subscription join, not an identity column). */
const EXPORTED_COLUMNS = new Set<string>([
  "id",
  "email",
  "createdAt",
  "role", // UserAdminRole.role -> the CSV's `role` column
]);

const REVIEWED_NON_EXPORTED_COLUMNS = new Set<string>([
  "passwordHash", // the actual secret this test exists to catch
  "emailVerifiedAt",
  "name",
  "image",
  "sessionsValidAfter", // internal JWT-kill-switch bookkeeping, not a credential
  "updatedAt",
  "accountId", // internal control_plane FK
  "accountRole", // billing OWNER/MEMBER role, not the admin role
  "userId", // companion-table PK, == id
  // Milestone 12 §4.1: not a secret, but out of scope for a SUPPORT export.
  // The MARKETING export path (same route, different purpose) filters ON
  // consent at the query level (exportUsers()'s marketingConsentOnly) without
  // ever adding the raw column to the output — reviewed and intentional.
  "consent",
  "consentAt",
  "consentSource",
  // a support lookup never needs to know when ToS was accepted
  "tosAcceptedAt",
]);

function identityScalarColumns(): string[] {
  const names = new Set<string>();
  for (const modelName of IDENTITY_MODELS) {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    expect(model, `${modelName} not found in Prisma DMMF — has it been renamed?`).toBeTruthy();
    for (const f of model!.fields) {
      if (f.kind !== "object") names.add(f.name);
    }
  }
  return [...names];
}

describe("User export field allowlist", () => {
  it("every user-identity column (CpUser + UserAdminRole + MarketingConsent) is either exported or explicitly reviewed", () => {
    const uncategorized = identityScalarColumns().filter(
      (name) => !EXPORTED_COLUMNS.has(name) && !REVIEWED_NON_EXPORTED_COLUMNS.has(name),
    );
    expect(
      uncategorized,
      "a user-identity column is neither exported nor reviewed — categorize it in user-export.ts or this test before merging",
    ).toEqual([]);
  });

  it("never exports passwordHash", () => {
    expect(USER_EXPORT_SELECT_FIELDS).not.toContain("passwordHash");
  });
});

describe("toCsv", () => {
  const rows: UserExportRow[] = [
    { id: "u1", email: "a@example.com", plan: "FREE", role: "USER", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "u2", email: 'quote"comma,name@example.com', plan: "BUSINESS", role: "SUPER_ADMIN", createdAt: "2026-08-02T00:00:00.000Z" },
  ];

  it("emits a header row matching the export field allowlist, in order", () => {
    const csv = toCsv(rows);
    expect(csv.split("\n")[0]).toBe(USER_EXPORT_SELECT_FIELDS.join(","));
  });

  it("quotes and escapes a field containing a comma or a double quote", () => {
    const csv = toCsv(rows);
    const secondDataLine = csv.split("\n")[2];
    expect(secondDataLine).toContain('"quote""comma,name@example.com"');
  });

  it("neutralizes a formula-injection payload in the email column end to end", () => {
    const malicious: UserExportRow[] = [{ id: "u3", email: "=1+1@example.com", plan: "FREE", role: "USER", createdAt: "2026-08-03T00:00:00.000Z" }];
    const dataLine = toCsv(malicious).split("\n")[1];
    expect(dataLine).toBe(`u3,"'=1+1@example.com",FREE,USER,2026-08-03T00:00:00.000Z`);
  });
});

/** Security review fix 2: CSV formula injection — see csvEscape's own doc comment for why the fix lives here rather than in isPlausibleEmail. */
describe("csvEscape — formula-injection guard", () => {
  it.each(["=SUM(A1:A10)", "+1234", "-1234", "@SUM(A1:A10)", "\tfoo", "\rfoo"])(
    "prefixes a single quote AND quotes a value beginning with a dangerous character (%j)",
    (value) => {
      expect(csvEscape(value)).toBe(`"'${value}"`);
    },
  );

  it("quotes (with no leading-guard prefix) a value containing a lone embedded \\r that isn't at the start", () => {
    expect(csvEscape("foo\rbar")).toBe('"foo\rbar"');
  });

  it("still quotes and escapes embedded double quotes underneath a dangerous prefix", () => {
    expect(csvEscape('=HYPERLINK("evil")')).toBe(`"'=HYPERLINK(""evil"")"`);
  });

  it("leaves an ordinary value completely unchanged", () => {
    expect(csvEscape("a@example.com")).toBe("a@example.com");
  });

  it("still quotes (unchanged behavior) a value with an internal comma or quote that doesn't start with a dangerous character", () => {
    expect(csvEscape("last,first")).toBe('"last,first"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });
});
