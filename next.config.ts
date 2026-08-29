import type { NextConfig } from "next";
import { GOOGLE_PIXEL_CSP_HOSTS } from "./src/lib/marketing/pixels/google";
import { LINKEDIN_PIXEL_CSP_HOSTS } from "./src/lib/marketing/pixels/linkedin";
import { META_PIXEL_CSP_HOSTS } from "./src/lib/marketing/pixels/meta";
import { TIKTOK_PIXEL_CSP_HOSTS } from "./src/lib/marketing/pixels/tiktok";

/**
 * Milestone 12 §4.2: split the ONE enforcing CSP Milestone 11 fix 1.7
 * shipped into two, route-scoped policies (Step 1), then widened the
 * public one with explicit per-vendor hosts as each vendor was added
 * (Step 2). `STRICT_CONTENT_SECURITY_POLICY` never changes as part of this
 * milestone — only `PUBLIC_CONTENT_SECURITY_POLICY` ever grows, and only
 * by explicit host, never a wildcard, never 'unsafe-eval', never a
 * widened default-src.
 *
 * Routing design — confirmed against node_modules/next/dist/docs/01-app/
 * 03-api-reference/05-config/01-next-config-js/headers.md's own "Header
 * Overriding Behavior" section before writing any of this ("If two headers
 * match the same path and set the same header key, the LAST header key
 * will override the first"), not assumed from training data (this fork's
 * own AGENTS.md explicitly warns APIs may differ):
 *
 *   1. ONE catch-all rule (`/:path*`) declared FIRST carries the FULL
 *      strict header set — HSTS, the strict CSP, X-Content-Type-Options,
 *      Referrer-Policy, X-Frame-Options, Permissions-Policy. This is the
 *      DEFAULT for every path, including `/dashboard`, `/admin`, every
 *      `/api` route, `/welcome`, `/unsubscribe`, and — critically — any
 *      FUTURE route nobody remembers to classify. Fail-closed: a new page
 *      is strict unless someone deliberately opts it into the list below.
 *   2. One rule PER entry in `PUBLIC_MARKETING_ROUTES`, declared AFTER the
 *      catch-all, each carrying ONLY a `Content-Security-Policy` header.
 *      Per the override rule above, this REPLACES the CSP value for that
 *      exact path while leaving every other header (HSTS, X-Frame-Options,
 *      etc.) untouched, since those keys are never redeclared here — there
 *      is exactly one definition of each non-CSP header in this whole
 *      file, so they can never drift between "strict" and "public" routes
 *      by accident.
 *
 * `/welcome` and `/unsubscribe` are deliberately NOT in the public list —
 * both are §4.1 mechanisms, not marketing content: `/welcome` requires an
 * authenticated session (redirects to /login otherwise) and carries the
 * same session-adjacent sensitivity as /dashboard; /unsubscribe's entire
 * purpose is opting OUT of marketing, so there is no legitimate reason for
 * a conversion pixel to ever load there.
 *
 * §4.2 Step 2 classification decision: `/login` and `/signup` are ALSO
 * deliberately NOT in this list, reversing Step 1's draft placement — those
 * are the two routes where a user types a password. A compromised or
 * malicious vendor script loaded there is credential capture, not analytics;
 * the blast radius is categorically different from a pixel on a read-only
 * page. Checked whether this costs any real attribution value before
 * excluding them: it doesn't — the one thing marketing genuinely needs from
 * signup (the conversion event itself) is captured server-side instead, via
 * `MarketingConversionEvent` (`src/lib/marketing/conversion-events.ts`),
 * recorded synchronously by the signup route (from the incoming request's
 * OWN cookie header, no client script involved) and dispatched
 * asynchronously by the worker — never a client script, so this table has
 * NO CSP entry of its own, per this phase's own "for any vendor
 * implemented server-side, no CSP entry should be needed at all" rule.
 * There is no equivalent server-observable moment for "a login happened"
 * that any ad platform actually wants to measure, so excluding /login
 * costs nothing at all.
 * `/pricing` has no separate route to classify — plan/pricing content is
 * the existing PricingSection component embedded directly in `/`, which is
 * already public; confirmed by reading the homepage, not assumed.
 *
 * Vendor 2 (Google Ads + GA4): see src/lib/marketing/pixels/google.ts's own
 * file comment for why GOOGLE_PIXEL_CSP_HOSTS deliberately omits
 * googleads.g.doubleclick.net (no client-side Ads conversion tag is ever
 * configured — conversions go server-side via GA4 Measurement Protocol,
 * same as Meta) and any region-sharded google-analytics.com collect host
 * (no wildcard, and no fixed list of region hosts exists to enumerate).
 *
 * Vendor 3 (TikTok): see src/lib/marketing/pixels/tiktok.ts's own file
 * comment for why TIKTOK_PIXEL_CSP_HOSTS deliberately omits
 * business-api.tiktok.com (that's the server-side Events API's own host,
 * never contacted by the browser) and any region-specific pixel/collect
 * variant (no confirmed evidence this app needs one yet — same scope
 * scrutiny applied to Google's region shards).
 *
 * Vendor 4 (LinkedIn): unlike Google/TikTok, LINKEDIN_PIXEL_CSP_HOSTS DOES
 * need img-src — see src/lib/marketing/pixels/linkedin.ts's own file
 * comment: LinkedIn's Insight Tag has a real, documented <noscript><img>
 * fallback (the same pattern Meta's pixel uses), unlike Google's/TikTok's
 * fetch/sendBeacon-only tags.
 */
const SHARED_SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * Unchanged from Milestone 11 fix 1.7 — see next-config-headers.test.ts and
 * that milestone's completion report for why each directive is what it is
 * (style-src 'unsafe-inline' for GrowthIntelligence.tsx/DetectionLog.tsx's
 * dynamic inline styles; connect-src 'self' for the SSE stream on
 * POST /api/analyze; no img-src override, verified no next/image or data:
 * usage exists). Applies to every route by default — /dashboard, /admin,
 * every /api route, /welcome, /unsubscribe, and any route not explicitly
 * listed in PUBLIC_MARKETING_ROUTES below.
 */
const BASE_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "connect-src": ["'self'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};

function buildCsp(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
    .join("; ");
}

const STRICT_CONTENT_SECURITY_POLICY = buildCsp(BASE_DIRECTIVES);

/**
 * One entry per vendor with a CLIENT-side pixel — added here explicitly,
 * by host, as each vendor is built. A vendor implemented entirely
 * server-side (its conversion events dispatched from the worker) needs NO
 * entry in this array at all; if a future change finds itself adding one
 * for a "server-side" vendor, that's a sign the implementation isn't
 * actually server-side and needs re-examining, not a CSP problem to solve.
 */
const VENDOR_CSP_HOSTS: { scriptSrc: string[]; connectSrc: string[]; imgSrc: string[] }[] = [
  META_PIXEL_CSP_HOSTS,
  GOOGLE_PIXEL_CSP_HOSTS,
  TIKTOK_PIXEL_CSP_HOSTS,
  LINKEDIN_PIXEL_CSP_HOSTS,
];

const PUBLIC_DIRECTIVES: Record<string, string[]> = {
  ...BASE_DIRECTIVES,
  "script-src": [...BASE_DIRECTIVES["script-src"], ...VENDOR_CSP_HOSTS.flatMap((v) => v.scriptSrc)],
  "connect-src": [...BASE_DIRECTIVES["connect-src"], ...VENDOR_CSP_HOSTS.flatMap((v) => v.connectSrc)],
  // BASE_DIRECTIVES has no img-src key at all (the strict policy relies on
  // default-src 'self' covering images, same as Milestone 11 fix 1.7
  // shipped it — see that comment above). The public policy needs its OWN
  // explicit img-src instead of inheriting that fallback: specifying
  // img-src at all removes the default-src fallback for this directive
  // specifically, so 'self' must be listed here explicitly too, or a
  // same-origin image (the site's own logo, etc.) would break on public
  // pages the moment a vendor host is added.
  "img-src": ["'self'", ...VENDOR_CSP_HOSTS.flatMap((v) => v.imgSrc)],
};

const PUBLIC_CONTENT_SECURITY_POLICY = buildCsp(PUBLIC_DIRECTIVES);

/**
 * The explicit allowlist — the ONLY paths that get the loosened policy.
 * Exported so this file's own test can assert against the real list
 * rather than a hand-copied duplicate that could drift from it.
 */
export const PUBLIC_MARKETING_ROUTES = ["/", "/terms", "/privacy"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // B4: emit `.next/standalone/` — a self-contained server bundle with only the
  // node_modules it actually imports — so the production Docker image copies
  // that instead of the full dependency tree. `next start` is unaffected.
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SHARED_SECURITY_HEADERS, { key: "Content-Security-Policy", value: STRICT_CONTENT_SECURITY_POLICY }],
      },
      ...PUBLIC_MARKETING_ROUTES.map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy", value: PUBLIC_CONTENT_SECURITY_POLICY }],
      })),
    ];
  },
};

export default nextConfig;
