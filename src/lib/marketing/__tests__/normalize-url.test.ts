import { describe, expect, it } from "vitest";
import {
  buildProductMatchIndex,
  matchDestinationUrl,
  normalizeUrlForMatch,
  productCanonicalUrl,
} from "../normalize-url";

describe("normalizeUrlForMatch", () => {
  it("returns null for unparseable input", () => {
    expect(normalizeUrlForMatch("not a url")).toBeNull();
    expect(normalizeUrlForMatch("")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizeUrlForMatch("javascript:alert(1)")).toBeNull();
    expect(normalizeUrlForMatch("ftp://example.com/products/blue-shirt")).toBeNull();
  });

  it("treats http and https as equivalent", () => {
    expect(normalizeUrlForMatch("http://example.com/products/blue-shirt")).toBe(
      normalizeUrlForMatch("https://example.com/products/blue-shirt"),
    );
  });

  it("strips www.", () => {
    expect(normalizeUrlForMatch("https://www.example.com/products/blue-shirt")).toBe(
      normalizeUrlForMatch("https://example.com/products/blue-shirt"),
    );
  });

  it("lowercases the host but preserves path case (Shopify handles are case-sensitive)", () => {
    const normalized = normalizeUrlForMatch("https://EXAMPLE.com/products/Blue-Shirt");
    expect(normalized).toBe("example.com/products/Blue-Shirt");
  });

  it("strips a single trailing slash, but not the bare root", () => {
    expect(normalizeUrlForMatch("https://example.com/products/blue-shirt/")).toBe(
      normalizeUrlForMatch("https://example.com/products/blue-shirt"),
    );
    expect(normalizeUrlForMatch("https://example.com/")).toBe("example.com/");
  });

  it("drops the fragment", () => {
    expect(normalizeUrlForMatch("https://example.com/products/blue-shirt#reviews")).toBe(
      normalizeUrlForMatch("https://example.com/products/blue-shirt"),
    );
  });

  it("drops the entire query string, including UTM/click-id tracking params", () => {
    const withTracking =
      "https://example.com/products/blue-shirt?utm_source=google&utm_campaign=x&gclid=abc123";
    expect(normalizeUrlForMatch(withTracking)).toBe(
      normalizeUrlForMatch("https://example.com/products/blue-shirt"),
    );
  });

  it("decodes percent-encoded path segments", () => {
    expect(normalizeUrlForMatch("https://example.com/products/blue%20shirt")).toBe(
      "example.com/products/blue shirt",
    );
  });

  it("falls back to the raw pathname on malformed percent-encoding rather than throwing", () => {
    expect(() => normalizeUrlForMatch("https://example.com/products/100%off")).not.toThrow();
  });

  it("a differently-shaped landing page does NOT match a product path", () => {
    const landingPage = normalizeUrlForMatch("https://example.com/pages/summer-sale");
    const productPage = normalizeUrlForMatch("https://example.com/products/blue-shirt");
    expect(landingPage).not.toBe(productPage);
  });
});

describe("productCanonicalUrl", () => {
  it("builds the standard Shopify product path", () => {
    expect(productCanonicalUrl("example.com", "blue-shirt")).toBe("https://example.com/products/blue-shirt");
  });
});

describe("buildProductMatchIndex + matchDestinationUrl", () => {
  const index = buildProductMatchIndex("example.com", [
    { id: "p1", handle: "blue-shirt" },
    { id: "p2", handle: "red-hat" },
  ]);

  it("matches an exact product URL with HIGH confidence", () => {
    const result = matchDestinationUrl("https://example.com/products/blue-shirt", index);
    expect(result).toEqual({ productId: "p1", method: "EXACT_PRODUCT_URL", confidence: "HIGH" });
  });

  it("matches through www/scheme/tracking-param differences (same normalized identity)", () => {
    const result = matchDestinationUrl(
      "http://www.example.com/products/red-hat?utm_source=google&gclid=xyz",
      index,
    );
    expect(result).toEqual({ productId: "p2", method: "EXACT_PRODUCT_URL", confidence: "HIGH" });
  });

  it("does not match a product from a DIFFERENT store's domain", () => {
    const result = matchDestinationUrl("https://competitor.com/products/blue-shirt", index);
    expect(result).toBeNull();
  });

  it("does not match a differently-shaped URL absent an explicit rule (e.g. a landing page)", () => {
    const result = matchDestinationUrl("https://example.com/pages/blue-shirt-promo", index);
    expect(result).toBeNull();
  });

  it("does not match an unknown product handle at the right store", () => {
    const result = matchDestinationUrl("https://example.com/products/green-scarf", index);
    expect(result).toBeNull();
  });

  it("returns null for a null destination URL (never guesses)", () => {
    expect(matchDestinationUrl(null, index)).toBeNull();
  });

  it("returns null for an unparseable destination URL", () => {
    expect(matchDestinationUrl("not a url", index)).toBeNull();
  });

  it("does not match a collection page URL — only /products/{handle} is indexed", () => {
    // Sub-phase B removed EXACT_COLLECTION_URL matching (AdObservation only
    // has a Product FK, no collection-match field) — an ad pointing at a
    // collection page is correctly left unmatched, not miscategorized.
    const result = matchDestinationUrl("https://example.com/collections/all", index);
    expect(result).toBeNull();
  });

  it("does not match a variant-scoped product URL differently from the base product — variant query is dropped", () => {
    // ?variant=123 is a real, legitimate Shopify query param (not tracking
    // junk) but product identity is still the path alone in this model.
    const result = matchDestinationUrl("https://example.com/products/blue-shirt?variant=987654321", index);
    expect(result).toEqual({ productId: "p1", method: "EXACT_PRODUCT_URL", confidence: "HIGH" });
  });

  it("a click-tracking redirect URL (e.g. Google's own aclk redirector) correctly matches nothing — never followed, never guessed", () => {
    // If a vendor's destination field is ever a tracking-redirect wrapper
    // rather than the true landing page, this system does NOT follow it
    // (no outbound fetch, no SSRF surface) — it just correctly reports no
    // match, which is the safe failure direction for this design (see
    // AGENTS.md-adjacent matching philosophy: under-match, never over-match).
    const result = matchDestinationUrl(
      "https://www.google.com/aclk?sa=l&ai=abc123&adurl=https://example.com/products/blue-shirt",
      index,
    );
    expect(result).toBeNull();
  });

  it("stress case: mixed-case host, www, trailing slash, and tracking query together still normalize to a match", () => {
    const result = matchDestinationUrl("HTTP://WWW.example.com/products/red-hat/?gclid=xyz&utm_source=g", index);
    expect(result).toEqual({ productId: "p2", method: "EXACT_PRODUCT_URL", confidence: "HIGH" });
  });
});
