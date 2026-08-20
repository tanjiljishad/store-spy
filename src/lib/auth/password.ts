import bcrypt from "bcryptjs";
import { isCommonPassword } from "./common-passwords";

/**
 * bcryptjs (pure JS, no native build step) over a native binding like
 * @node-rs/argon2 — this project already hit native-binary friction once
 * (embedded Postgres on Windows); password hashing isn't hot-path enough
 * for the perf difference to matter.
 */
const SALT_ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

/**
 * Length, a common-password blocklist (common-passwords.ts), and rejecting
 * the caller's own email local-part — no composition rules (no forced
 * symbol/digit/case mix). Composition requirements are deliberately
 * excluded: NIST SP 800-63B's own guidance is that they push users toward
 * predictable substitutions ("password" -> "P@ssw0rd") that reduce real
 * entropy while feeling stricter, and this app has no interest in that
 * theater. Never silently "fix" a password — every rejection is explicit.
 *
 * `email` is optional so this stays callable in email-agnostic contexts,
 * but the signup route (the only real caller) always supplies it.
 */
export function isPasswordAcceptable(plaintext: string, email?: string): boolean {
  if (typeof plaintext !== "string") return false;
  if (plaintext.length < MIN_PASSWORD_LENGTH || plaintext.length > MAX_PASSWORD_LENGTH) return false;
  if (isCommonPassword(plaintext)) return false;

  if (email) {
    const localPart = email.split("@")[0]?.trim().toLowerCase();
    if (localPart && localPart.length >= 3 && plaintext.toLowerCase().includes(localPart)) {
      return false;
    }
  }

  return true;
}
