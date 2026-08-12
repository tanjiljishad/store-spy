import { describe, expect, it } from "vitest";
import { classifyFreshness } from "../freshness";
import type { PersistenceResult } from "../persistence";

const OBSERVED: PersistenceResult = {
  status: "OBSERVED",
  observedActiveCount: 10,
  windowCrawlCount: 10,
  ratio: 1,
  windowStart: new Date("2026-01-01"),
  windowEnd: new Date("2026-08-01"),
};

describe("classifyFreshness", () => {
  it("is RECENTLY_MISSING whenever status is not ACTIVE, regardless of persistence data", () => {
    expect(classifyFreshness("MISSING", OBSERVED)).toBe("RECENTLY_MISSING");
    expect(classifyFreshness("REMOVED", OBSERVED)).toBe("RECENTLY_MISSING");
    expect(
      classifyFreshness("MISSING", { status: "INSUFFICIENT_HISTORY", realCrawlsAvailable: 0, storeRealCrawlCount: 0 }),
    ).toBe("RECENTLY_MISSING");
  });

  it("is ESTABLISHED for an ACTIVE product with observed persistence, regardless of the exact ratio", () => {
    expect(classifyFreshness("ACTIVE", OBSERVED)).toBe("ESTABLISHED");
    expect(classifyFreshness("ACTIVE", { ...OBSERVED, ratio: 0.4 })).toBe("ESTABLISHED");
  });

  it("is NEW when the product lacks history but the store itself has plenty", () => {
    const result = classifyFreshness("ACTIVE", {
      status: "INSUFFICIENT_HISTORY",
      realCrawlsAvailable: 1,
      storeRealCrawlCount: 15,
    });
    expect(result).toBe("NEW");
  });

  it("is INSUFFICIENT_HISTORY when the store itself hasn't been crawled enough times yet", () => {
    const result = classifyFreshness("ACTIVE", {
      status: "INSUFFICIENT_HISTORY",
      realCrawlsAvailable: 2,
      storeRealCrawlCount: 2,
    });
    expect(result).toBe("INSUFFICIENT_HISTORY");
  });
});
