import { createGoogleAdsSource } from "./sources/google-serpapi";
import type { MarketingAdSource } from "./types";

/**
 * The one place that reads SERPAPI_API_KEY. Fails loudly and early rather
 * than letting a scheduler tick silently no-op or crash deep inside a
 * vendor call with a confusing error — same "fail closed on missing
 * config" discipline as SCHEDULER_SECRET in the scheduler tick route.
 */
export function getConfiguredMarketingSource(): MarketingAdSource {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SERPAPI_API_KEY is not configured — marketing collection cannot run without vendor credentials",
    );
  }
  return createGoogleAdsSource({ apiKey });
}
