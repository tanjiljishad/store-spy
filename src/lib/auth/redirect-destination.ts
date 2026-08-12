import { canonicalizeDomain } from "../crawl/shopify";

/**
 * Where to land once auth completes. Always builds a fixed-prefix internal
 * relative path from a canonicalized domain — never trusts or forwards an
 * arbitrary URL from the query string, so this can't become an open
 * redirect no matter what `storeParam` contains. `claim=1` tells the Store
 * Intelligence page to spend one analysis credit on this already-crawled
 * store instead of requiring the user to re-submit it (see that page and
 * AuthForm.tsx).
 */
export function authDestination(storeParam: string | undefined): string {
  if (!storeParam) return "/dashboard";
  const domain = canonicalizeDomain(storeParam);
  if (!domain || !domain.includes(".") || /\s/.test(domain)) return "/dashboard";
  return `/dashboard/stores/${encodeURIComponent(domain)}?claim=1`;
}
