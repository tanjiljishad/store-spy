import { isPlausibleEmail } from "../auth/normalize-email";

/**
 * Milestone 12 §4.1 addendum: extends audit.ts's own "metadata must never
 * contain secrets" rule to cover PII. `recordAdminAction()` calls this on
 * every write — see that file's doc comment. Recursively walks the whole
 * `metadata` value (objects, arrays, and nested combinations of both) so a
 * PII leak buried two levels deep (e.g. `filters.emailQuery`) is caught the
 * same as a top-level one.
 *
 * Deliberately reuses `isPlausibleEmail()` — the same "does this look like
 * an email" check the signup route itself uses to validate input — rather
 * than a second, possibly-divergent regex. "Email-shaped" is the doc's own
 * phrase and the one concrete, well-defined PII pattern this schema
 * actually has today (no phone numbers, physical addresses, or similar
 * fields exist anywhere `metadata` is built from).
 */
export function containsEmailShapedValue(value: unknown): boolean {
  if (typeof value === "string") return isPlausibleEmail(value);
  if (Array.isArray(value)) return value.some(containsEmailShapedValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsEmailShapedValue);
  }
  return false;
}
