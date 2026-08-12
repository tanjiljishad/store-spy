import type { PrismaClient } from "@prisma/client";
import { normalizeEmail } from "./normalize-email";
import { verifyPassword } from "./password";

export interface VerifiedIdentity {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
}

/**
 * The actual email/password check, factored out of the Credentials
 * provider's authorize() callback so it's directly unit/integration
 * testable without going through NextAuth's request pipeline.
 */
export async function verifyCredentials(
  prisma: PrismaClient,
  emailInput: string,
  password: string,
): Promise<VerifiedIdentity | null> {
  const email = normalizeEmail(emailInput);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) return null; // OAuth-only user has no password to check

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;

  return { id: user.id, email: user.email, name: user.name, image: user.image };
}
