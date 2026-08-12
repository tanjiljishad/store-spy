/**
 * Every entry point that touches User.email (Credentials signup, Credentials
 * login, OAuth profile callbacks) must funnel through this so the same
 * person typing "Foo@Example.com" and "foo@example.com" is one account, not
 * two — Postgres's unique constraint on email is case-sensitive by default.
 */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isPlausibleEmail(input: string): boolean {
  const email = input.trim();
  return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
