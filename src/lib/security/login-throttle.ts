import type { PrismaClient } from "@prisma/client";
import { evaluateLoginThrottle, LOGIN_ATTEMPT_WINDOW_MS, type LoginThrottleDecision } from "./login-policy";

/**
 * The database-backed half of the login throttle: counts recent `LoginAttempt`
 * rows and hands them to the pure policy in login-policy.ts. Backed by a
 * table, not the in-memory rate limiter (rate-limit.ts), because lockout
 * state must survive a process restart and be visible to every instance —
 * an in-memory Map is neither.
 */

export async function checkLoginThrottle(
  prisma: PrismaClient,
  emailNormalized: string,
  ipKey: string,
  now: Date = new Date(),
): Promise<LoginThrottleDecision> {
  const since = new Date(now.getTime() - LOGIN_ATTEMPT_WINDOW_MS);

  const [emailFailuresInWindow, ipFailuresInWindow] = await Promise.all([
    prisma.loginAttempt.count({ where: { emailNormalized, succeeded: false, createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { ipKey, succeeded: false, createdAt: { gte: since } } }),
  ]);

  return evaluateLoginThrottle({ emailFailuresInWindow, ipFailuresInWindow });
}

/**
 * Records one login attempt's outcome. A SUCCESS clears that email's failure
 * rows — since a row carries both the email and the IP that made it, this
 * also drops those rows from that IP's own failure count. Accepted
 * deliberately, not overlooked: the per-IP threshold (30) is already loose
 * specifically because a shared IP hitting many different accounts is
 * normal, so a little extra slack for an IP that just watched one of those
 * accounts succeed is in the same spirit, not a meaningful new hole.
 */
export async function recordLoginAttempt(
  prisma: PrismaClient,
  emailNormalized: string,
  ipKey: string,
  succeeded: boolean,
  now: Date = new Date(),
): Promise<void> {
  await prisma.loginAttempt.create({ data: { emailNormalized, ipKey, succeeded, createdAt: now } });
  if (succeeded) {
    await prisma.loginAttempt.deleteMany({ where: { emailNormalized, succeeded: false } });
  }
}
