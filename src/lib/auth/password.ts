import bcrypt from "bcryptjs";

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

const MIN_PASSWORD_LENGTH = 8;

/** Minimal, honest validation — length only. Never silently "fix" a password. */
export function isPasswordAcceptable(plaintext: string): boolean {
  return typeof plaintext === "string" && plaintext.length >= MIN_PASSWORD_LENGTH && plaintext.length <= 200;
}
