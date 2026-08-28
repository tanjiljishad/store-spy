import { generateEmailVerificationToken } from "../auth/email-verification-token";
import { sendEmail } from "./resend-client";

/**
 * `baseUrl` is the ORIGIN of the request that triggered the send (e.g.
 * `req.nextUrl.origin` from the signup / resend-verification routes) — not
 * a dedicated env var. This app has no staging/production deploy yet (see
 * docs/environment-variables.md), and the origin the request actually
 * arrived on is already the correct link target in every environment
 * without needing a new var to keep in sync per environment.
 */
export function buildVerificationUrl(baseUrl: string, userId: string, email: string): string | null {
  const token = generateEmailVerificationToken(userId, email);
  if (!token) return null;
  const url = new URL("/verify-email", baseUrl);
  url.searchParams.set("uid", userId);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Throws if EMAIL_VERIFICATION_TOKEN_SECRET is unset or the send itself fails — callers decide whether that's fatal (see the signup route's non-fatal try/catch vs. the resend route's 502). */
export async function sendVerificationEmail(baseUrl: string, userId: string, email: string): Promise<void> {
  const url = buildVerificationUrl(baseUrl, userId, email);
  if (!url) {
    throw new Error("Cannot send verification email — EMAIL_VERIFICATION_TOKEN_SECRET is not set.");
  }

  await sendEmail({
    to: email,
    subject: "Confirm your email — Bellwether",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h1 style="font-size: 20px;">Confirm your email</h1>
        <p style="font-size: 14px; line-height: 1.6;">
          Click the button below to confirm your email address and unlock your Bellwether dashboard.
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
        <p style="font-size: 12px; color: #999;">If you didn't create a Bellwether account, you can ignore this email.</p>
      </div>
    `,
  });
}
