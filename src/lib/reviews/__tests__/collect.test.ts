import { describe, expect, it, vi } from "vitest";
import { detectSharedCounts, fetchAndParseCandidate, type CandidateOutcome } from "../collect";
import type { ReviewSampleCandidate } from "../sampling";
import type { DnsLookup } from "../../security/ssrf-guard";

// Same convention as crawl/__tests__/shopify.test.ts's SAFE_DNS — stands in
// for "yes, this domain is safe to crawl" without a real DNS lookup, which
// would otherwise fail for the fake test domain and get rejected by the
// SSRF guard before fetchImpl is ever called.
const SAFE_DNS: DnsLookup = async () => [{ address: "8.8.8.8" }];

function candidate(id: string, handle: string): ReviewSampleCandidate {
  return { id, externalId: id, handle };
}

function htmlWithCount(handle: string, count: number): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "Product",
    url: `https://store.example.com/products/${handle}`,
    aggregateRating: { reviewCount: count },
  })}</script></head></html>`;
}

function jsonResponse(text: string, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(text) };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

describe("fetchAndParseCandidate", () => {
  it("wasRead=true, real reviewCount when the page has usable JSON-LD", async () => {
    const c = candidate("p1", "cool-shirt");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(htmlWithCount("cool-shirt", 218)));
    const outcome = await fetchAndParseCandidate("store.example.com", c, { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: SAFE_DNS });
    expect(outcome).toEqual({ candidate: c, wasRead: true, reviewCount: 218, ratingValue: null });
  });

  it("wasRead=true, reviewCount=null when the page is read but has no usable review data — never a fabricated 0", async () => {
    const c = candidate("p1", "plain-shirt");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("<html><body>no ld+json here</body></html>"));
    const outcome = await fetchAndParseCandidate("store.example.com", c, { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: SAFE_DNS });
    expect(outcome).toEqual({ candidate: c, wasRead: true, reviewCount: null, ratingValue: null });
  });

  it("wasRead=false when the page fetch itself fails (blocked/403) — never recorded as an absence", async () => {
    const c = candidate("p1", "blocked-shirt");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("forbidden", false, 403));
    const outcome = await fetchAndParseCandidate("store.example.com", c, { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: SAFE_DNS });
    expect(outcome.wasRead).toBe(false);
    expect(outcome.reviewCount).toBeNull();
  });

  it("wasRead=false when fetch throws (network error) — never crashes the batch", async () => {
    const c = candidate("p1", "timeout-shirt");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const outcome = await fetchAndParseCandidate("store.example.com", c, { fetchImpl: fetchImpl as unknown as typeof fetch, dnsLookup: SAFE_DNS });
    expect(outcome.wasRead).toBe(false);
    expect(outcome.reviewCount).toBeNull();
  });
});

describe("detectSharedCounts", () => {
  function outcome(id: string, reviewCount: number | null): CandidateOutcome {
    return { candidate: candidate(id, id), wasRead: true, reviewCount, ratingValue: null };
  }

  it("does not flag distinct counts", () => {
    const shared = detectSharedCounts([outcome("a", 10), outcome("b", 20), outcome("c", 30)]);
    expect(shared.size).toBe(0);
  });

  it("flags two products sharing the exact same non-null count (product-group sharing)", () => {
    const shared = detectSharedCounts([outcome("a", 1626), outcome("b", 1626), outcome("c", 40)]);
    expect(shared.has("a")).toBe(true);
    expect(shared.has("b")).toBe(true);
    expect(shared.has("c")).toBe(false);
  });

  it("never flags based on null (unobserved) values — that would be a fabricated match, not a real one", () => {
    const shared = detectSharedCounts([outcome("a", null), outcome("b", null), outcome("c", null)]);
    expect(shared.size).toBe(0);
  });

  it("does not aggregate or sum — only marks, every observation is still retained individually by the caller", () => {
    const outcomes = [outcome("a", 100), outcome("b", 100)];
    const shared = detectSharedCounts(outcomes);
    // detectSharedCounts itself never returns a sum/total — only a Set of ids to flag.
    expect(shared).toBeInstanceOf(Set);
    expect([...shared].sort()).toEqual(["a", "b"]);
  });
});
