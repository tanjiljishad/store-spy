import { describe, expect, it } from "vitest";
import { extractReviewObservation } from "../jsonld-parser";

function page(...scripts: string[]): string {
  return `<html><head>${scripts
    .map((s) => `<script type="application/ld+json">${s}</script>`)
    .join("\n")}</head><body></body></html>`;
}

const HANDLE = "cool-shirt";

describe("extractReviewObservation — supported shapes", () => {
  it("1. Product + AggregateRating (the common shape)", () => {
    const html = page(
      JSON.stringify({
        "@context": "https://schema.org/",
        "@type": "Product",
        url: "https://store.example.com/products/cool-shirt",
        aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5, reviewCount: 218 },
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 218, ratingValue: 4.5 });
  });

  it("2. ProductGroup + AggregateRating on the group itself", () => {
    const html = page(
      JSON.stringify({
        "@type": "ProductGroup",
        url: "https://store.example.com/products/cool-shirt",
        productGroupID: "COOL_SHIRT",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 44 },
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 44, ratingValue: null });
  });

  it("3. nested AggregateRating — bare node with itemReviewed (confirmed live on allbirds.com)", () => {
    const html = page(
      JSON.stringify({
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4",
          reviewCount: "44",
          itemReviewed: { "@type": "Product", url: "https://store.example.com/products/cool-shirt" },
        },
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 44, ratingValue: 4 });
  });

  it("4. @graph structure", () => {
    const html = page(
      JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", url: "https://store.example.com/products/cool-shirt" },
          {
            "@type": "Product",
            url: "https://store.example.com/products/cool-shirt",
            aggregateRating: { "@type": "AggregateRating", reviewCount: 12 },
          },
        ],
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 12, ratingValue: null });
  });

  it("5. top-level JSON-LD array", () => {
    const html = page(
      JSON.stringify([
        { "@type": "BreadcrumbList" },
        {
          "@type": "Product",
          url: "https://store.example.com/products/cool-shirt",
          aggregateRating: { "@type": "AggregateRating", reviewCount: 7 },
        },
      ]),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 7, ratingValue: null });
  });

  it("6. reviewCount as a string (confirmed the majority real-world case)", () => {
    const html = page(
      JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: "3449" } }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 3449, ratingValue: null });
  });

  it("7. reviewCount as a number", () => {
    const html = page(JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: 53 } }));
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 53, ratingValue: null });
  });

  it("8. malformed JSON-LD does not throw and does not block a later valid block", () => {
    const html = page(
      "{ this is not valid json )",
      JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: 9 } }),
    );
    expect(() => extractReviewObservation(html, { handle: HANDLE })).not.toThrow();
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 9, ratingValue: null });
  });

  it("8b. every block malformed — AMBIGUOUS, not a crash and not a silent zero", () => {
    const html = page("{ broken", "also not json {{{");
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result.status).toBe("AMBIGUOUS");
  });

  it("9. multiple JSON-LD blocks on one page, rating in the second", () => {
    const html = page(
      JSON.stringify({ "@type": "BreadcrumbList" }),
      JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: 5 } }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 5, ratingValue: null });
  });

  it("10. negative reviewCount is rejected as invalid, not silently accepted", () => {
    const html = page(JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: -3 } }));
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result.status).toBe("PRESENT_BUT_INVALID");
  });

  it("11. decimal reviewCount is rejected as invalid (a fractional review count is nonsensical)", () => {
    const html = page(JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: 3.5 } }));
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result.status).toBe("PRESENT_BUT_INVALID");
  });

  it("12. AggregateRating present, reviewCount missing entirely — PRESENT_BUT_INVALID, not ABSENT, not 0", () => {
    const html = page(JSON.stringify({ "@type": "Product", aggregateRating: { ratingValue: 4.2 } }));
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result.status).toBe("PRESENT_BUT_INVALID");
  });

  it("13. unrelated AggregateRating (e.g. an Organization-wide trust score) is never mistaken for the product's own", () => {
    const html = page(
      JSON.stringify({
        "@type": "Organization",
        name: "Example Store",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 9999 },
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result.status).toBe("ABSENT");
  });

  it("14. product identity mismatch — multiple products/ratings on the page, none matching the fetched handle", () => {
    const html = page(
      JSON.stringify({
        "@type": "Product",
        url: "https://store.example.com/products/other-shirt-a",
        aggregateRating: { reviewCount: 10 },
      }),
      JSON.stringify({
        "@type": "Product",
        url: "https://store.example.com/products/other-shirt-b",
        aggregateRating: { reviewCount: 20 },
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result.status).toBe("AMBIGUOUS");
  });

  it("15. ProductGroup + hasVariant siblings, rating on the group, one of several nested variant Products", () => {
    const html = page(
      JSON.stringify({
        "@type": "ProductGroup",
        url: "https://store.example.com/products/cool-shirt",
        aggregateRating: { "@type": "AggregateRating", reviewCount: 1626, ratingValue: 4.9 },
        hasVariant: [
          { "@type": "Product", sku: "A", url: "https://store.example.com/products/cool-shirt?variant=1" },
          { "@type": "Product", sku: "B", url: "https://store.example.com/products/cool-shirt?variant=2" },
        ],
      }),
    );
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 1626, ratingValue: 4.9 });
  });

  it("resolves a relative url against the fetched handle", () => {
    const html = page(JSON.stringify({ "@type": "Product", url: "/products/cool-shirt", aggregateRating: { reviewCount: 3 } }));
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "PRESENT", reviewCount: 3, ratingValue: null });
  });

  it("no ld+json at all on the page is a clean ABSENT, never a fabricated 0", () => {
    const html = "<html><head></head><body>no structured data here</body></html>";
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "ABSENT" });
  });

  it("Product with no aggregateRating block at all is ABSENT", () => {
    const html = page(JSON.stringify({ "@type": "Product", url: "https://store.example.com/products/cool-shirt", sku: "X" }));
    const result = extractReviewObservation(html, { handle: HANDLE });
    expect(result).toEqual({ status: "ABSENT" });
  });

  it("never throws on deeply pathological/self-referential-looking input", () => {
    const circularLike = JSON.stringify({ "@type": "Product", aggregateRating: { reviewCount: 1 }, self: { self: { self: {} } } });
    expect(() => extractReviewObservation(page(circularLike), { handle: HANDLE })).not.toThrow();
  });
});
