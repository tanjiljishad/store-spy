import { randomBytes } from "node:crypto";

/**
 * Crockford base32 — no I/L/O/U, so a human reading a code aloud or typing
 * it never confuses a letter for a digit. 32 characters exactly, which
 * matters for generatePromoCode()'s unbiased byte-to-character mapping
 * below: 256 (one byte's range) divides evenly by 32, so `byte % 32` is
 * perfectly uniform — no modulo bias to reason about.
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CODE_LENGTH = 12; // 12 * 5 bits = 60 bits of entropy

/** crypto.randomBytes, never Math.random — see the module doc above for the entropy math. */
export function generatePromoCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return code;
}

/** The unique index is on this normalized form — "abc-def" and "ABCDEF" can never both exist as distinct rows. */
export function normalizePromoCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

const VANITY_CODE_PATTERN = /^[A-Z0-9]{4,32}$/;

/** Applied to an already-normalized vanity code (e.g. "LAUNCH50"). Collision rejection is the caller's job — this is shape validation only. */
export function isValidVanityCode(normalizedCode: string): boolean {
  return VANITY_CODE_PATTERN.test(normalizedCode);
}
