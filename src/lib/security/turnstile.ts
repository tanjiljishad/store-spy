/**
 * Milestone 12 §1.3: server-side verification of a Cloudflare Turnstile
 * token for the anonymous analysis form. Fail-closed the same way
 * SCHEDULER_SECRET does (see security/constant-time-equal.ts's callers): an
 * unset TURNSTILE_SECRET_KEY makes every verification fail rather than
 * silently skip the check — a misconfigured deployment refuses anonymous
 * traffic instead of quietly accepting it unchecked.
 */

export interface VerifyTurnstileResult {
  ok: boolean;
  reason?: string;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstileToken(
  token: string | null | undefined,
  opts: { fetchImpl?: typeof fetch; remoteIp?: string } = {},
): Promise<VerifyTurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "turnstile_not_configured" };
  if (!token) return { ok: false, reason: "missing_token" };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({ secret, response: token });
  if (opts.remoteIp) body.set("remoteip", opts.remoteIp);

  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return { ok: false, reason: `siteverify http ${res.status}` };
    const data = (await res.json()) as { success?: boolean };
    return data.success === true ? { ok: true } : { ok: false, reason: "verification_failed" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "network_error" };
  }
}
