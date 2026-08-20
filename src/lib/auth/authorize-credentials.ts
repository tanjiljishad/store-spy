import type { PrismaClient } from "@prisma/client";
import { normalizeEmail } from "./normalize-email";
import { verifyCredentials, type VerifiedIdentity } from "./verify-credentials";
import { checkLoginThrottle, recordLoginAttempt } from "../security/login-throttle";

/**
 * The throttled email/password check, factored out of the Credentials
 * provider's authorize() callback for the same reason verify-credentials.ts
 * itself is (see that file's own doc comment): directly unit/integration
 * testable without going through NextAuth's request pipeline. This owns the
 * throttle-check -> verify -> record sequence, so there is exactly one
 * implementation of "is this login attempt allowed right now," not one
 * inline in auth.ts and a second one some test has to reconstruct.
 *
 * Checked BEFORE verifyCredentials, never after: verifyPassword runs bcrypt
 * at cost 12 (~250ms of blocked CPU per call), so a locked-out or throttled
 * attempt must never reach it — that's a single-process denial-of-service
 * vector, not just an account-guessing one (this milestone's doc, item 1.2).
 */
export async function authorizeCredentials(
  prisma: PrismaClient,
  emailInput: string,
  password: string,
  ipKey: string,
): Promise<VerifiedIdentity | null> {
  const emailNormalized = normalizeEmail(emailInput);

  const decision = await checkLoginThrottle(prisma, emailNormalized, ipKey);
  if (decision.outcome === "locked") {
    // Still recorded, so continued hammering keeps extending the lock
    // window rather than the count quietly aging back out from under it.
    await recordLoginAttempt(prisma, emailNormalized, ipKey, false);
    // MUST be null, never a distinguishable thrown error — a locked
    // response has to be byte-identical to a wrong-password response, or
    // this becomes an account-existence/state oracle.
    return null;
  }
  if (decision.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
  }

  const identity = await verifyCredentials(prisma, emailInput, password);
  await recordLoginAttempt(prisma, emailNormalized, ipKey, identity !== null);
  return identity;
}
