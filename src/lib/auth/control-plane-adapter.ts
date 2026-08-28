import type { PrismaClient } from "@prisma/client";
import type { Adapter, AdapterUser } from "@auth/core/adapters";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { randomUUID } from "node:crypto";
import { provisionStoreSpyAccount, trialEndsFromNow } from "../control-plane/provision";

/**
 * B2 step 2·A adapter. Wraps the stock `@auth/prisma-adapter` (which still
 * reads/writes `store_spy.User`) and overrides ONLY the two methods that
 * create or mutate a user, so that OAuth first sign-in also provisions the
 * control-plane account (`control_plane.{accounts,users,subscriptions,
 * entitlements}`).
 *
 * TRANSITIONAL: every override here ALSO writes a shadow `store_spy.User`
 * row (same id) — the `*_userId_fkey` constraints still point at
 * `store_spy.User` until migration `20260828180000` (B2 step 2), and gates +
 * billing still read `User.plan` until B2 step 2·B. **B2 step 2·B replaces
 * this whole file with a control-plane-native adapter and removes the shadow
 * writes.** If that step slips, this scaffolding is what silently keeps the
 * old FK satisfiable — grep for "TRANSITIONAL (B2 step 2·B)".
 */
export function controlPlaneAdapter(prisma: PrismaClient): Adapter {
  const base = PrismaAdapter(prisma);

  return {
    ...base,

    async createUser(user) {
      const id = randomUUID();
      const email = user.email;
      const name = user.name ?? null;
      const image = user.image ?? null;
      const emailVerifiedAt = user.emailVerified ?? null;

      const created = await prisma.$transaction(async (tx) => {
        await provisionStoreSpyAccount(tx, {
          userId: id,
          email,
          passwordHash: null, // OAuth-only user
          name,
          emailVerifiedAt,
          tosAcceptedAt: null, // set later by the /welcome interstitial
          trialEndsAt: trialEndsFromNow(),
        });
        // TRANSITIONAL (B2 step 2·B): shadow store_spy.User row + its consent
        // row. OAuth users start with consent=false; the /welcome interstitial
        // may flip it via grantMarketingConsent().
        const shadow = await tx.user.create({
          data: { id, email, name, image, emailVerified: emailVerifiedAt, plan: "FREE", role: "USER", freeTrialEndsAt: trialEndsFromNow() },
        });
        await tx.marketingConsent.create({ data: { userId: id, consent: false } });
        return shadow;
      });

      return toAdapterUser(created);
    },

    async updateUser({ id, ...data }) {
      const cpData: Record<string, unknown> = {};
      const ssData: Record<string, unknown> = {};
      if (data.email !== undefined) {
        cpData.email = data.email;
        ssData.email = data.email;
      }
      if (data.name !== undefined) {
        cpData.name = data.name;
        ssData.name = data.name;
      }
      if (data.image !== undefined) ssData.image = data.image; // control_plane.users has no image column reader; keep it on the shadow row
      if (data.emailVerified !== undefined) {
        cpData.emailVerifiedAt = data.emailVerified;
        ssData.emailVerified = data.emailVerified;
      }

      const updated = await prisma.$transaction(async (tx) => {
        if (Object.keys(cpData).length > 0) await tx.cpUser.updateMany({ where: { id }, data: cpData });
        // TRANSITIONAL (B2 step 2·B): keep the shadow store_spy.User row in step.
        return tx.user.update({ where: { id }, data: ssData });
      });

      return toAdapterUser(updated);
    },
  };
}

function toAdapterUser(row: {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: Date | null;
}): AdapterUser {
  return { id: row.id, email: row.email, name: row.name, image: row.image, emailVerified: row.emailVerified };
}
