import type { PrismaClient } from "@prisma/client";
import type { Adapter, AdapterUser } from "@auth/core/adapters";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { randomUUID } from "node:crypto";
import { provisionStoreSpyAccount, trialEndsFromNow } from "../control-plane/provision";

/**
 * The Auth.js adapter. Wraps `@auth/prisma-adapter` for the `Account` /
 * `Session` / `VerificationToken` plumbing (still `store_spy` tables) but
 * routes every USER read and write to `control_plane.users` — that is the
 * account of record (B2 2·B).
 *
 * TRANSITIONAL (B2 step 2·B commit 3): createUser/updateUser also write a
 * shadow `store_spy.User` row so the non-auth `store_spy.User` readers
 * (dashboard label, account/export, consent gates) keep working until they
 * are repointed. Commit 3 removes those writes. Grep "TRANSITIONAL (B2 step 2·B)".
 */
export function controlPlaneAdapter(prisma: PrismaClient): Adapter {
  const base = PrismaAdapter(prisma);

  return {
    ...base,

    getUser: (id) => cpUserToAdapter(prisma, { id }),
    getUserByEmail: (email) => cpUserToAdapter(prisma, { email }),
    async getUserByAccount({ provider, providerAccountId }) {
      const account = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        select: { userId: true },
      });
      return account ? cpUserToAdapter(prisma, { id: account.userId }) : null;
    },

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

async function cpUserToAdapter(
  prisma: PrismaClient,
  where: { id: string } | { email: string },
): Promise<AdapterUser | null> {
  const u = await prisma.cpUser.findUnique({
    where,
    select: { id: true, email: true, name: true, image: true, emailVerifiedAt: true },
  });
  return u ? toAdapterUser({ ...u, emailVerified: u.emailVerifiedAt }) : null;
}
