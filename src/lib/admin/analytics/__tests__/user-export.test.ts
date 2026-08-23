import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { USER_EXPORT_SELECT_FIELDS, csvEscape, toCsv, type UserExportRow } from "../user-export";

/**
 * Milestone 12 Section 3.3: "Assert this in a test that fails if a new
 * sensitive User column is ever added without being excluded." Reads the
 * User model straight from Prisma's DMMF (no DB connection needed — this
 * is schema metadata baked into the generated client) rather than
 * hand-copying schema.prisma's field list, so it can't silently drift out
 * of date with the schema. Every field must be explicitly categorized: in
 * the export allowlist, or in REVIEWED_NON_EXPORTED_FIELDS below with a
 * human having looked at it and confirmed it isn't a secret. A brand-new
 * column lands in NEITHER set and fails this test until someone decides.
 */
const REVIEWED_NON_EXPORTED_FIELDS = new Set<string>([
  "passwordHash", // the actual secret this test exists to catch
  "emailVerified",
  "name",
  "image",
  "sessionsValidAfter", // internal JWT-kill-switch bookkeeping, not a credential
  "freeTrialEndsAt",
  "updatedAt",
  // Milestone 12 §4.1: not a secret, but out of scope for a SUPPORT export
  // specifically — this CSV's `purpose:"support"` path never needs consent
  // status to answer a support ticket. The MARKETING export path (same
  // route, different purpose) filters ON marketingConsent at the query
  // level (see exportUsers()'s marketingConsentOnly option) without ever
  // adding the raw field to the output columns — reviewed and intentional,
  // not an oversight.
  "marketingConsent",
  "marketingConsentAt",
  "marketingConsentSource",
  // Same reasoning as the marketingConsent fields above — a support lookup
  // never needs to know when ToS was accepted; not sensitive, just out of
  // this CSV's scope.
  "tosAcceptedAt",
  // relations — never joined into a bulk user export
  "accounts",
  "sessions",
  "watchlists",
  "analysisUsage",
  "permissionGrants",
]);

describe("User export field allowlist", () => {
  it("every field on the Prisma User model is either exported or explicitly reviewed as safe to omit", () => {
    const userModel = Prisma.dmmf.datamodel.models.find((m) => m.name === "User");
    expect(userModel, "User model not found in Prisma DMMF — has it been renamed?").toBeTruthy();

    const uncategorized = userModel!.fields
      .map((f) => f.name)
      .filter((name) => !(USER_EXPORT_SELECT_FIELDS as readonly string[]).includes(name) && !REVIEWED_NON_EXPORTED_FIELDS.has(name));

    expect(uncategorized, "a User field exists that is neither exported nor reviewed — categorize it in user-export.ts or this test before merging").toEqual([]);
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
