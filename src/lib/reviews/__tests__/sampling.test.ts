import { describe, expect, it } from "vitest";
import {
  chooseReviewBudget,
  MAX_REVIEW_OBSERVATION_PRODUCTS,
  MAX_REVIEW_OBSERVATION_PRODUCTS_NO_PROVIDER,
} from "../sampling";

describe("chooseReviewBudget", () => {
  it("18. gives the full budget when a review provider is detected", () => {
    expect(chooseReviewBudget(["okendo"])).toBe(MAX_REVIEW_OBSERVATION_PRODUCTS);
  });

  it("gives the full budget for any detected provider, not just Okendo", () => {
    expect(chooseReviewBudget(["yotpo"])).toBe(MAX_REVIEW_OBSERVATION_PRODUCTS);
  });

  it("19. gives a smaller, non-zero budget when no provider is detected (never zero — real positive outliers exist, e.g. tarte.com)", () => {
    const budget = chooseReviewBudget([]);
    expect(budget).toBe(MAX_REVIEW_OBSERVATION_PRODUCTS_NO_PROVIDER);
    expect(budget).toBeGreaterThan(0);
  });

  it("16. the with-provider budget matches the documented maximum sample size", () => {
    expect(MAX_REVIEW_OBSERVATION_PRODUCTS).toBe(20);
  });
});
