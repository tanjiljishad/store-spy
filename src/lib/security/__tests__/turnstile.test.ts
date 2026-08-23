import { afterEach, describe, expect, it } from "vitest";
import { verifyTurnstileToken } from "../turnstile";

describe("verifyTurnstileToken", () => {
  const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
  });

  it("fails closed when TURNSTILE_SECRET_KEY is not configured — same convention as SCHEDULER_SECRET", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchImpl = async () => new Response(JSON.stringify({ success: true }), { status: 200 });

    const result = await verifyTurnstileToken("some-token", { fetchImpl });

    expect(result).toEqual({ ok: false, reason: "turnstile_not_configured" });
  });

  it("fails closed when no token is supplied, even with a configured secret", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const fetchImpl = async () => new Response(JSON.stringify({ success: true }), { status: 200 });

    expect(await verifyTurnstileToken(null, { fetchImpl })).toEqual({ ok: false, reason: "missing_token" });
    expect(await verifyTurnstileToken(undefined, { fetchImpl })).toEqual({ ok: false, reason: "missing_token" });
    expect(await verifyTurnstileToken("", { fetchImpl })).toEqual({ ok: false, reason: "missing_token" });
  });

  it("succeeds when Cloudflare's siteverify returns success: true", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const fetchImpl = async () => new Response(JSON.stringify({ success: true }), { status: 200 });

    expect(await verifyTurnstileToken("a-real-token", { fetchImpl })).toEqual({ ok: true });
  });

  it("fails when Cloudflare's siteverify returns success: false", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const fetchImpl = async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 });

    expect(await verifyTurnstileToken("a-bad-token", { fetchImpl })).toEqual({ ok: false, reason: "verification_failed" });
  });

  it("fails when the siteverify request itself errors (non-2xx)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const fetchImpl = async () => new Response("bad gateway", { status: 502 });

    const result = await verifyTurnstileToken("token", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("502");
  });

  it("fails closed on a network error, rather than throwing", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };

    const result = await verifyTurnstileToken("token", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("network unreachable");
  });

  it("sends the secret and token as form-encoded POST body, plus remoteip when supplied", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };

    await verifyTurnstileToken("the-token", { fetchImpl, remoteIp: "203.0.113.5" });

    expect(capturedInit?.method).toBe("POST");
    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("the-token");
    expect(body.get("remoteip")).toBe("203.0.113.5");
  });
});
