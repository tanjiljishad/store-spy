import type { PrismaClient } from "@prisma/client";
import { grantMarketingConsent, OAUTH_WELCOME_CONSENT_SOURCE } from "../marketing/consent";

/**
 * Milestone 12 §4.1 addendum: the OAuth-signup consent gate. Google/Facebook
 * sign-in creates the `User` row directly through the Auth.js Prisma
 * adapter, with no form and no consent-checkbox moment at all — this is
 * that moment, deferred to first dashboard access instead of signup time.
 *
 * `needsConsentInterstitial()` is the ONE condition `DashboardLayout`
 * checks: `control_plane.users.tosAcceptedAt IS NULL`. Deliberately not
 * derived from the JWT — this reads a fresh row, mirroring how
 * `/dashboard/settings` already does its own fresh read for fields the
 * session token doesn't carry, rather than extending jwt-session-refresh.ts's
 * cached-claims machinery for a condition that, once true, never needs to be
 * re-checked more than once per account's whole lifetime.
 */
export async function needsConsentInterstitial(prisma: Pick<PrismaClient, "cpUser">, userId: string): Promise<boolean> {
  const user = await prisma.cpUser.findUnique({ where: { id: userId }, select: { tosAcceptedAt: true } });
  // A user row that's vanished (e.g. mid-deletion) needs no interstitial —
  // there's nothing left to gate, and DashboardLayout's own getCurrentUser()
  // check handles "no real account" separately.
  if (!user) return false;
  return user.tosAcceptedAt === null;
}

export interface RecordOAuthWelcomeConsentArgs {
  marketingConsent: boolean;
}

/**
 * Sets `tosAcceptedAt` unconditionally (the interstitial cannot be
 * submitted without checking the required ToS box — see the route) and, if
 * `marketingConsent` was also checked, grants marketing consent with the
 * SAME `OAUTH_WELCOME_CONSENT_SOURCE` discipline the signup form uses for
 * its own source — composes `grantMarketingConsent()` rather than
 * duplicating its write, so there is exactly one place `marketingConsent`
 * is ever set to `true`.
 */
export async function recordOAuthWelcomeConsent(
  prisma: PrismaClient,
  userId: string,
  args: RecordOAuthWelcomeConsentArgs,
  now: Date = new Date(),
): Promise<void> {
  // TRANSITIONAL (B2 step 2·B): the store_spy.User.tosAcceptedAt write. 2·A
  // keeps it next to the control_plane.users write; 2·B drops the shadow half
  // and repoints needsConsentInterstitial() to control_plane.users.
  await prisma.user.update({ where: { id: userId }, data: { tosAcceptedAt: now } });
  await prisma.cpUser.updateMany({ where: { id: userId }, data: { tosAcceptedAt: now } });
  if (args.marketingConsent) {
    await grantMarketingConsent(prisma, userId, OAUTH_WELCOME_CONSENT_SOURCE, now);
  }
}
