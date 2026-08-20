import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * next.config.ts's headers() is a plain async function Next.js calls to
 * build every response's headers — testable directly, with no live server
 * or browser needed. See this milestone's doc, item 1.7.
 */
describe("next.config headers()", () => {
  it("applies the full security header set to every route", async () => {
    if (!nextConfig.headers) throw new Error("headers() is not configured");
    const rules = await nextConfig.headers();

    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe("/:path*");

    const byKey = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));

    expect(byKey["Strict-Transport-Security"]).toContain("max-age=63072000");
    expect(byKey["Strict-Transport-Security"]).toContain("includeSubDomains");
    expect(byKey["Strict-Transport-Security"]).toContain("preload");

    expect(byKey["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(byKey["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(byKey["Content-Security-Policy"]).toContain("base-uri 'self'");
    expect(byKey["Content-Security-Policy"]).toContain("form-action 'self'");
    // The SSE stream on POST /api/analyze is a same-origin fetch + streamed
    // read — connect-src must allow 'self' or it breaks.
    expect(byKey["Content-Security-Policy"]).toContain("connect-src 'self'");

    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
    expect(byKey["Permissions-Policy"]).toContain("microphone=()");
    expect(byKey["Permissions-Policy"]).toContain("geolocation=()");
  });
});
