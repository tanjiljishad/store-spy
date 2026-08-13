import { describe, expect, it } from "vitest";
import { computeReviewObservationSignal, type ReviewObservationRow } from "../signal";

const D = (s: string) => new Date(s);

function row(reviewCount: number | null, observedAt: string, sharedWithGroup = false, ratingValue: number | null = null): ReviewObservationRow {
  return { reviewCount, ratingValue, observedAt: D(observedAt), sharedWithGroup };
}

describe("computeReviewObservationSignal — state selection", () => {
  it("21. first observation ever — OBSERVED, no change (no fabricated 0-baseline)", () => {
    const result = computeReviewObservationSignal([row(218, "2026-08-01")]);
    expect(result).toEqual({
      status: "OBSERVED",
      reviewCount: 218,
      ratingValue: null,
      observedAt: D("2026-08-01"),
      sharedWithGroup: false,
      change: null,
    });
  });

  it("22/23. second observation — OBSERVED with an increase", () => {
    const result = computeReviewObservationSignal([row(231, "2026-08-10"), row(218, "2026-08-01")]);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.reviewCount).toBe(231);
    expect(result.change).toEqual({ previousCount: 218, delta: 13 });
  });

  it("a decrease is reported honestly, not clamped or hidden", () => {
    const result = computeReviewObservationSignal([row(190, "2026-08-10"), row(218, "2026-08-01")]);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.change).toEqual({ previousCount: 218, delta: -28 });
  });

  it("28. OBSERVED when the latest row has a real count", () => {
    expect(computeReviewObservationSignal([row(5, "2026-08-01")]).status).toBe("OBSERVED");
  });

  it("29/30. UNSUPPORTED when the most recent sample found nothing, even if an earlier one did", () => {
    // Store used to have a count, then a later crawl's sample found nothing
    // (e.g. the theme changed, or a different product got sampled that day).
    const result = computeReviewObservationSignal([row(null, "2026-08-10"), row(218, "2026-08-01")]);
    expect(result).toEqual({ status: "UNSUPPORTED" });
  });

  it("NOT_SAMPLED when there is no row at all — distinct from UNSUPPORTED", () => {
    expect(computeReviewObservationSignal([])).toEqual({ status: "NOT_SAMPLED" });
  });

  it("25/26. missing prior observation never becomes a fabricated 0 -> N delta", () => {
    const result = computeReviewObservationSignal([row(231, "2026-08-10")]);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.change).toBeNull();
  });

  it("skips a null-count row in between to find the real prior count", () => {
    const result = computeReviewObservationSignal([row(231, "2026-08-15"), row(null, "2026-08-10"), row(218, "2026-08-01")]);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.change).toEqual({ previousCount: 218, delta: 13 });
  });

  it("27. carries sharedWithGroup through untouched — caller decides how to present it, this never aggregates", () => {
    const result = computeReviewObservationSignal([row(1626, "2026-08-01", true)]);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.sharedWithGroup).toBe(true);
  });

  it("carries ratingValue through", () => {
    const result = computeReviewObservationSignal([row(10, "2026-08-01", false, 4.7)]);
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.ratingValue).toBe(4.7);
  });
});
