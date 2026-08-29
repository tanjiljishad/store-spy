import type { PrismaClient } from "@prisma/client";

/**
 * Milestone 12 §4.1 / B2 2·B: the only place `store_spy.MarketingConsent` is
 * ever written — grantMarketingConsent() and revokeMarketingConsent() are the
 * two verbs. Both are one `upsert` with a clear, named reason to exist as
 * functions rather than being inlined at each call site: consistency of
 * exactly what gets written (never partially — `consent` and its
 * `At`/`Source` companions always change together or not at all).
 *
 * Two capture surfaces exist, hence two source constants: the credentials
 * signup form (synchronous — the route creates the MarketingConsent row
 * directly inside its own signup transaction rather than calling
 * grantMarketingConsent() here, so there is no window where the row exists
 * with the default `false` contradicted by an in-flight `true` already
 * promised; see the signup route's own comment) and the post-OAuth consent
 * interstitial (`/welcome`, `src/lib/account/consent.ts`) — a real
 * `upsert()`, since that row already exists by the time it runs.
 */
export const SIGNUP_FORM_CONSENT_SOURCE = "signup_form";
export const OAUTH_WELCOME_CONSENT_SOURCE = "oauth_welcome_interstitial";

export async function grantMarketingConsent(
  db: Pick<PrismaClient, "marketingConsent">,
  userId: string,
  source: string,
  now: Date = new Date(),
): Promise<void> {
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
export async function revokeMarketingConsent(db: Pick<PrismaClient, "marketingConsent">, userId: string): Promise<void> {
  await db.marketingConsent.upsert({ where: { userId }, create: { userId, consent: false }, update: { consent: false } });
}
