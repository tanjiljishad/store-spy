import { generateEmailVerificationToken } from "../auth/email-verification-token";
import { sendEmail } from "./resend-client";

/**
 * The public origin every mailed link is built against — `APP_URL`, a fixed
 * env var, NEVER the incoming request's `Host` header.
 *
 * Audit fix M-2: this used to take `baseUrl` from `req.nextUrl.origin` at the
 * signup / resend-verification routes. `Host` is attacker-controlled, so a
 * signup for `victim@example.com` sent with `Host: attacker.tld` produced a
 * confirmation link pointing at the attacker. Pinning to `APP_URL` removes the
 * request from the equation. (The token itself is now time-bounded too — see
 * email-verification-token.ts, audit fix M-4.)
 *
 * Fail-closed, same posture as EMAIL_VERIFICATION_TOKEN_SECRET: an unset or
 * malformed `APP_URL` yields `null` (no link, no email) rather than a link
 * against some guessed origin. `docs/environment-variables.md` lists it as
 * required in staging/production.
 */
function appOrigin(): string | null {
  const raw = process.env.APP_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Null if `APP_URL` or `EMAIL_VERIFICATION_TOKEN_SECRET` is missing/invalid — callers must treat that as "cannot mail a working link," never emit a broken one. */
export function buildVerificationUrl(userId: string, email: string): string | null {
  const origin = appOrigin();
  if (!origin) return null;
  const token = generateEmailVerificationToken(userId, email);
  if (!token) return null;
  const url = new URL("/verify-email", origin);
  url.searchParams.set("uid", userId);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Throws if `APP_URL` / `EMAIL_VERIFICATION_TOKEN_SECRET` is unset or the send itself fails — callers decide whether that's fatal (see the signup route's non-fatal try/catch vs. the resend route's 502). */
export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const url = buildVerificationUrl(userId, email);
  if (!url) {
    throw new Error(
      "Cannot send verification email — APP_URL or EMAIL_VERIFICATION_TOKEN_SECRET is not set (see docs/environment-variables.md).",
    );
  }

  await sendEmail({
    to: email,
    subject: "Store Spy — Confirm your email",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h1 style="font-size: 20px;">Confirm your email</h1>
        <p style="font-size: 14px; line-height: 1.6;">
          Click the button below to confirm your email address and unlock your dashboard.
        </p>
        <p style="margin: 28px 0;">
          <a href="${url}" style="background: #FFB627; color: #1A1204; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
            Confirm email
          </a>
        </p>
        <p style="font-size: 12px; line-height: 1.6; color: #666;">
          If the button doesn't work, copy and paste this link into your browser:<br />
          <a href="${url}" style="color: #666;">${url}</a>
        </p>
        <p style="font-size: 12px; color: #999;">If you didn't create an account, you can ignore this email.</p>
      </div>
    `,
  });
}
