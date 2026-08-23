import { GooglePixel } from "./pixels/GooglePixel";
import { LinkedInPixel } from "./pixels/LinkedInPixel";
import { MetaPixel } from "./pixels/MetaPixel";
import { TikTokPixel } from "./pixels/TikTokPixel";

/**
 * Milestone 12 §4.2 Step 2: the ONE aggregator every public marketing page
 * imports — one line added per vendor as each is built, never a growing
 * list of per-page imports. Deliberately mounted from individual page
 * files (`/`, `/terms`, `/privacy`), never from the root layout — that's
 * what makes "no pixel component is importable from the dashboard or
 * admin layouts" a real, structural property (their own import graphs
 * never reach this file at all) rather than a runtime pathname check like
 * CookieConsentBanner.tsx's. See no-pixels-in-protected-layouts.test.ts.
 *
 * Each individual pixel component (MetaPixel, GooglePixel, TikTokPixel,
 * LinkedInPixel, and whatever's added next) owns its own
 * consent/flag/configuration gating — this component adds no gating of
 * its own, so there is exactly one place per vendor that decides whether
 * it fires.
 */
export function MarketingPixels() {
  return (
    <>
      <MetaPixel />
      <GooglePixel />
      <TikTokPixel />
      <LinkedInPixel />
    </>
  );
}
