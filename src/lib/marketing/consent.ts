import type { PrismaClient } from "@prisma/client";

/**
 * Milestone 12 §4.1: the only place `User.marketingConsent` is ever
 * written — grantMarketingConsent() and revokeMarketingConsent() are the
 * two verbs. Neither is Prisma-heavy enough to warrant splitting query
 * from policy the way analytics/ does; both are one `update` call with a
 * clear, named reason to exist as functions rather than being inlined at
 * each call site: consistency of exactly what gets written (never
 * partially — `marketingConsent` and its `At`/`Source` companions always
 * change together or not at all).
 *
 * Two capture surfaces exist, hence two source constants: the credentials
 * signup form (synchronous — the route inlines the fields directly into
 * its own `user.create()` call rather than calling grantMarketingConsent()
 * here, specifically so there is no window where the row exists with the
 * default `false` contradicted by an in-flight `true` already promised;
 * see the signup route's own comment) and the post-OAuth consent
 * interstitial (`/welcome`, `src/lib/account/consent.ts`) — a real
 * `update()`, since that row already exists by the time it runs.
 */
export const SIGNUP_FORM_CONSENT_SOURCE = "signup_form";
export const OAUTH_WELCOME_CONSENT_SOURCE = "oauth_welcome_interstitial";

export async function grantMarketingConsent(
  db: Pick<PrismaClient, "user" | "marketingConsent">,
  userId: string,
  source: string,
  now: Date = new Date(),
): Promise<void> {
  // TRANSITIONAL (B2 step 2·B): the store_spy.User column write. 2·A keeps it
  // next to the store_spy.MarketingConsent table write; 2·B drops the column
  // half and repoints readers to the table.
  await db.user.update({
    where: { id: userId },
    data: { marketingConsent: true, marketingConsentAt: now, marketingConsentSource: source },
  });
  await db.marketingConsent.upsert({
    where: { userId },
    create: { userId, consent: true, consentAt: now, consentSource: source },
    update: { consent: true, consentAt: now, consentSource: source },
  });
}

/**
 * Flips `marketingConsent` back to `false`. Deliberately leaves
 * `marketingConsentAt`/`marketingConsentSource` untouched — they record
 * WHEN/WHERE consent was originally granted, which stays true and worth
 * keeping even after it's revoked (the same append-only-history spirit as
 * AdminAuditLog, applied to a boolean instead of a row). Idempotent: no
 * error, no-op in effect, if the user had never actually consented.
 */
export async function revokeMarketingConsent(db: Pick<PrismaClient, "user" | "marketingConsent">, userId: string): Promise<void> {
  // TRANSITIONAL (B2 step 2·B): dual-write, same as grantMarketingConsent.
  await db.user.update({ where: { id: userId }, data: { marketingConsent: false } });
  await db.marketingConsent.upsert({ where: { userId }, create: { userId, consent: false }, update: { consent: false } });
}
