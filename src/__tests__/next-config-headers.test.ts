import { describe, expect, it } from "vitest";
import nextConfig, { PUBLIC_MARKETING_ROUTES } from "../../next.config";
import { GOOGLE_PIXEL_CSP_HOSTS } from "../lib/marketing/pixels/google";
import { LINKEDIN_PIXEL_CSP_HOSTS } from "../lib/marketing/pixels/linkedin";
import { META_PIXEL_CSP_HOSTS } from "../lib/marketing/pixels/meta";
import { TIKTOK_PIXEL_CSP_HOSTS } from "../lib/marketing/pixels/tiktok";

/** Every vendor with a client-side CSP footprint — grows as each is added. Used so this file's own assertions never need updating per vendor beyond this one array. */
const ALL_VENDOR_CSP_HOSTS = [META_PIXEL_CSP_HOSTS, GOOGLE_PIXEL_CSP_HOSTS, TIKTOK_PIXEL_CSP_HOSTS, LINKEDIN_PIXEL_CSP_HOSTS];
const ALL_VENDOR_HOSTS = ALL_VENDOR_CSP_HOSTS.flatMap((v) => [...v.scriptSrc, ...v.connectSrc, ...v.imgSrc]);

/**
 * next.config.ts's headers() is a plain async function Next.js calls to
 * build every response's headers — testable directly, with no live server
 * or browser needed. See Milestone 11's doc item 1.7 and Milestone 12 §4.2.
 *
 * `resolveHeaders()` below is a real, minimal implementation of this
 * fork's own documented override rule (node_modules/next/dist/docs/.../
 * headers.md, "Header Overriding Behavior": "If two headers match the same
 * path and set the same header key, the LAST header key will override the
 * first") — not a re-check of the rules array's shape, which would pass
 * even if the routing were subtly wrong (e.g. rule order reversed). It's
 * intentionally simple (exact-match or the literal `/:path*` catch-all)
 * because that's the entire vocabulary next.config.ts actually uses; it
 * does not need to be a general path-to-regexp implementation.
 */
function matchesSource(source: string, path: string): boolean {
  if (source === "/:path*") return true;
  return source === path;
}

function resolveHeaders(rules: { source: string; headers: { key: string; value: string }[] }[], path: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const rule of rules) {
    if (!matchesSource(rule.source, path)) continue;
    for (const h of rule.headers) resolved[h.key] = h.value; // later matches override earlier ones for the same key, in array order — exactly the documented rule
  }
  return resolved;
}

describe("next.config headers()", () => {
  it("the catch-all rule (applied to every route by default) carries the full strict header set", async () => {
    if (!nextConfig.headers) throw new Error("headers() is not configured");
    const rules = await nextConfig.headers();

    const catchAll = rules.find((r) => r.source === "/:path*");
    expect(catchAll).toBeTruthy();
    const byKey = Object.fromEntries(catchAll!.headers.map((h) => [h.key, h.value]));

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
    // No vendor host ever appears in the strict policy — the one thing
    // this whole §4.2 mechanism exists to guarantee.
    for (const host of ALL_VENDOR_HOSTS) {
      expect(byKey["Content-Security-Policy"]).not.toContain(host);
    }

    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Permissions-Policy"]).toContain("camera=()");
    expect(byKey["Permissions-Policy"]).toContain("microphone=()");
    expect(byKey["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("public-route override rules carry ONLY Content-Security-Policy — never redeclaring the other five headers, so those can never drift between strict and public routes", async () => {
    if (!nextConfig.headers) throw new Error("headers() is not configured");
    const rules = await nextConfig.headers();

    const publicRules = rules.filter((r) => r.source !== "/:path*");
    expect(publicRules.map((r) => r.source).sort()).toEqual([...PUBLIC_MARKETING_ROUTES].sort());
    for (const rule of publicRules) {
      expect(rule.headers.map((h) => h.key)).toEqual(["Content-Security-Policy"]);
    }
  });

  it("PUBLIC_MARKETING_ROUTES never includes a protected path — a hard-coded safety net independent of the resolver below", () => {
    const protectedPrefixes = ["/dashboard", "/admin", "/api", "/welcome", "/unsubscribe", "/login", "/signup"];
    for (const route of PUBLIC_MARKETING_ROUTES) {
      for (const prefix of protectedPrefixes) {
        expect(route === prefix || route.startsWith(`${prefix}/`)).toBe(false);
      }
    }
  });

  it("PUBLIC_MARKETING_ROUTES is exactly the doc's own current classification — /login and /signup are password-entry routes, deliberately excluded", () => {
    expect([...PUBLIC_MARKETING_ROUTES].sort()).toEqual(["/", "/privacy", "/terms"]);
  });

  describe("resolved policy per path (simulating this fork's own documented override rule)", () => {
    it("dashboard, admin, api, welcome, unsubscribe, login, and signup all resolve to the STRICT policy", async () => {
      if (!nextConfig.headers) throw new Error("headers() is not configured");
      const rules = await nextConfig.headers();
      const strictCsp = resolveHeaders(rules, "/some/never-listed/route")["Content-Security-Policy"];

      for (const path of [
        "/dashboard",
        "/dashboard/settings",
        "/admin",
        "/admin/users",
        "/api/analyze",
        "/api/auth/signup",
        "/welcome",
        "/unsubscribe",
        "/login", // §4.2 Step 2: password-entry route, deliberately reverted to strict
        "/signup", // same — see next.config.ts's own classification comment
        "/some/brand-new/future/route", // never explicitly classified — must fail closed to strict
      ]) {
        const resolved = resolveHeaders(rules, path);
        expect(resolved["Content-Security-Policy"], `expected ${path} to resolve to the strict policy`).toBe(strictCsp);
      }
    });

    it("every route in PUBLIC_MARKETING_ROUTES resolves to the public policy specifically (its own override rule wins, not just the catch-all)", async () => {
      if (!nextConfig.headers) throw new Error("headers() is not configured");
      const rules = await nextConfig.headers();

      for (const path of PUBLIC_MARKETING_ROUTES) {
        const winningRule = [...rules].reverse().find((r) => matchesSource(r.source, path) && r.headers.some((h) => h.key === "Content-Security-Policy"));
        expect(winningRule?.source, `expected ${path}'s CSP to come from its own override rule, not the catch-all`).toBe(path);
      }
    });

    // §4.2 Step 2: the strict/public divergence Step 1's own test predicted
    // ("expected to start failing the moment Step 2 adds a real vendor
    // entry") — that prediction is now this assertion, in the opposite
    // direction: the two policies MUST differ, and specifically by exactly
    // every configured vendor's explicit hosts (Meta, then Google), added
    // to script-src/connect-src/img-src only.
    it("Step 2: the public policy differs from strict by EXACTLY every vendor's explicit hosts — nothing else changed", async () => {
      if (!nextConfig.headers) throw new Error("headers() is not configured");
      const rules = await nextConfig.headers();
      const strictCsp = resolveHeaders(rules, "/dashboard")["Content-Security-Policy"];
      const publicCsp = resolveHeaders(rules, "/")["Content-Security-Policy"];

      expect(publicCsp).not.toBe(strictCsp);
      for (const host of ALL_VENDOR_HOSTS) {
        expect(publicCsp).toContain(host);
      }
      // Every directive present in strict is STILL present in public,
      // verbatim — the widening only ADDS vendor hosts, never removes or
      // narrows an existing allowance.
      for (const directive of strictCsp.split("; ")) {
        expect(publicCsp).toContain(directive);
      }
      // No wildcard, no 'unsafe-eval', never a widened default-src — the
      // three explicit non-negotiables.
      expect(publicCsp).not.toContain("*");
      expect(publicCsp).not.toContain("unsafe-eval");
      expect(publicCsp.match(/default-src [^;]+/)?.[0]).toBe(strictCsp.match(/default-src [^;]+/)?.[0]);
      // Explicitly absent — the hosts a wildcard/guess would have reached
      // for, per each vendor's own scope decision (see google.ts, tiktok.ts).
      expect(publicCsp).not.toContain("googleads.g.doubleclick.net");
      expect(publicCsp).not.toMatch(/region\d+\.google-analytics\.com/);
      expect(publicCsp).not.toContain("business-api.tiktok.com");
    });
  });
});
