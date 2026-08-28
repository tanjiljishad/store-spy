/**
 * Thin wrapper over Resend's REST API — a plain fetch() call, not the
 * `resend` SDK, matching this codebase's existing PROVIDER SEAM convention
 * (see marketing/pixels/meta.ts) of talking to a vendor's HTTP API directly
 * rather than pulling in a dependency for what is a single POST.
 */

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
}

/**
 * Throws on failure — unlike the marketing pixels' PROVIDER SEAM (deliberately
 * unfilled until §4.3), this IS the real, filled-in send path. A caller that
 * needs "failure shouldn't break the request" (e.g. the signup route) wraps
 * this in its own try/catch rather than this function silently swallowing an
 * error the caller would otherwise have no way to detect or log.
 */
export async function sendEmail({ to, subject, html }: SendEmailArgs): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error("Email is not configured — RESEND_API_KEY and EMAIL_FROM must both be set.");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${body.slice(0, 500)}`);
  }
}
