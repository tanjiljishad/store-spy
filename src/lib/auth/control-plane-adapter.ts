import type { PrismaClient } from "@prisma/client";
import type { Adapter, AdapterUser } from "@auth/core/adapters";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { randomUUID } from "node:crypto";
import { provisionStoreSpyAccount, trialEndsFromNow } from "../control-plane/provision";

/**
 * The Auth.js adapter. Wraps `@auth/prisma-adapter` for the `Account` /
 * `Session` / `VerificationToken` plumbing (still `store_spy` tables) but
 * routes every USER read and write to `control_plane.users` — that is the
 * account of record (B2 2·B). As of commit 3b it no longer writes a shadow
 * `store_spy.User` row; createUser still seeds the per-product
 * `store_spy.MarketingConsent` row.
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

      await prisma.$transaction(async (tx) => {
        await provisionStoreSpyAccount(tx, {
          userId: id,
          email,
          passwordHash: null, // OAuth-only user
          name,
          image,
          emailVerifiedAt,
          tosAcceptedAt: null, // set later by the /welcome interstitial
          trialEndsAt: trialEndsFromNow(),
        });
        // OAuth users start with consent=false; the /welcome interstitial may
        // flip it via grantMarketingConsent().
        await tx.marketingConsent.create({ data: { userId: id, consent: false } });
      });

      return { id, email, name, image, emailVerified: emailVerifiedAt };
    },

    async updateUser({ id, ...data }) {
      const cpData: Record<string, unknown> = {};
      if (data.email !== undefined) cpData.email = data.email;
      if (data.name !== undefined) cpData.name = data.name;
      if (data.image !== undefined) cpData.image = data.image;
      if (data.emailVerified !== undefined) cpData.emailVerifiedAt = data.emailVerified;

      if (Object.keys(cpData).length > 0) await prisma.cpUser.updateMany({ where: { id }, data: cpData });

      const fresh = await cpUserToAdapter(prisma, { id });
      if (!fresh) throw new Error(`updateUser: no control_plane.users row for ${id}`);
      return fresh;
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
