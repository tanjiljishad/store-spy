import { describe, expect, it } from "vitest";
import { getReviewInfrastructureSignal, REVIEW_APP_KEYS } from "../review-infrastructure";

describe("getReviewInfrastructureSignal", () => {
  it("returns UNAVAILABLE with an honest reason before the store has ever been crawled — never queries the DB", async () => {
    // Passing a Prisma client stand-in that throws on any call proves the
    // early-return path never touches the database for a store that hasn't
    // baselined yet.
    const explodingPrisma = {
      storeEntity: {
        findMany: () => {
          throw new Error("should not be called");
        },
      },
    } as never;

    const result = await getReviewInfrastructureSignal(explodingPrisma, "store_1", null);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: "This store has not completed an initial crawl yet." });
  });

  it("REVIEW_APP_KEYS matches the exact set of review-app fingerprint signatures", () => {
    expect(REVIEW_APP_KEYS).toEqual(["judgeme", "yotpo", "loox", "stamped", "okendo"]);
  });
});
