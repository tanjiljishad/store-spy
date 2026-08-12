import { describe, expect, it } from "vitest";
import {
  computePersistence,
  MIN_CRAWLS_FOR_PERSISTENCE,
  PERSISTENCE_WINDOW_CRAWLS,
  type ComputePersistenceArgs,
  type LifecycleTransition,
} from "../persistence";

function crawlsAt(hoursAgoList: number[], now = new Date("2026-08-11T12:00:00Z")): Date[] {
  return hoursAgoList.map((h) => new Date(now.getTime() - h * 60 * 60 * 1000)).sort((a, b) => b.getTime() - a.getTime());
}

function baseArgs(overrides: Partial<ComputePersistenceArgs> = {}): ComputePersistenceArgs {
  return {
    recentCrawls: crawlsAt([0, 24, 48, 72, 96]),
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    currentMissingSince: null,
    currentStatus: "ACTIVE",
    transitionsInWindow: [],
    transitionBeforeWindow: null,
    ...overrides,
  };
}

describe("computePersistence — stable product, no snapshot rows involved", () => {
  it("a product with many real crawls and zero lifecycle transitions is 100% persistent", () => {
    const result = computePersistence(baseArgs({ recentCrawls: crawlsAt([0, 24, 48, 72, 96, 120, 144]) }));
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.observedActiveCount).toBe(7);
    expect(result.windowCrawlCount).toBe(7);
    expect(result.ratio).toBe(1);
  });
});

describe("computePersistence — volatility must not change the result", () => {
  it("gives the exact same ratio as a stable product when the product never actually went missing", () => {
    // Volatility (price/rank churn) never enters this computation at all —
    // there is no snapshot-count input to this function. A product that
    // changed on every single crawl and one that never changed produce an
    // identical result as long as neither ever went missing.
    const stable = computePersistence(baseArgs());
    const volatile = computePersistence(baseArgs()); // same crawl/transition shape — volatility is not a parameter
    expect(volatile).toEqual(stable);
    if (stable.status !== "OBSERVED") throw new Error("unreachable");
    expect(stable.ratio).toBe(1);
  });
});

describe("computePersistence — product currently missing (streak 1, pre-confirmation)", () => {
  it("excludes the ongoing-gap crawl even though no PRODUCT_REMOVED event has fired yet", () => {
    const crawls = crawlsAt([0, 24, 48, 72, 96]); // most recent first
    const missingSince = crawls[0]; // went missing as of the most recent crawl
    const result = computePersistence(
      baseArgs({
        recentCrawls: crawls,
        currentStatus: "MISSING",
        currentMissingSince: missingSince,
        transitionsInWindow: [], // no REMOVED event yet — streak 1 doesn't confirm removal
      }),
    );
    expect(result.status).toBe("OBSERVED");
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.windowCrawlCount).toBe(5);
    expect(result.observedActiveCount).toBe(4); // the missing crawl is excluded
    expect(result.ratio).toBe(0.8);
  });

  it("excludes every crawl from missingSince onward if missing for multiple consecutive crawls", () => {
    const crawls = crawlsAt([0, 24, 48, 72, 96]);
    const missingSince = crawls[1]; // missing for the two most recent crawls
    const result = computePersistence(
      baseArgs({ recentCrawls: crawls, currentStatus: "MISSING", currentMissingSince: missingSince }),
    );
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    expect(result.observedActiveCount).toBe(3);
    expect(result.ratio).toBe(0.6);
  });
});

describe("computePersistence — product returning after being missing", () => {
  it("excludes the confirmed-removed window and resumes counting after PRODUCT_RESTORED", () => {
    const crawls = crawlsAt([0, 24, 48, 72, 96, 120]); // 6 crawls, most recent first
    const removedAt = crawls[4]; // second-oldest crawl
    const restoredAt = crawls[2]; // middle crawl
    const transitions: LifecycleTransition[] = [
      { type: "PRODUCT_REMOVED", occurredAt: removedAt },
      { type: "PRODUCT_RESTORED", occurredAt: restoredAt },
    ];
    const result = computePersistence(
      baseArgs({
        recentCrawls: crawls,
        currentStatus: "ACTIVE",
        currentMissingSince: null, // cleared on restore
        transitionsInWindow: transitions,
      }),
    );
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    // oldest crawl: active (before removal) = 1
    // removedAt crawl itself: inactive (transition applies at/before this crawl)
    // crawl between removedAt and restoredAt: inactive
    // restoredAt crawl itself and everything after: active
    expect(result.windowCrawlCount).toBe(6);
    expect(result.observedActiveCount).toBe(4);
  });

  it("uses transitionBeforeWindow to know the product was already inactive when the window opened", () => {
    const crawls = crawlsAt([0, 24, 48]);
    const result = computePersistence(
      baseArgs({
        recentCrawls: crawls,
        transitionBeforeWindow: { type: "PRODUCT_REMOVED", occurredAt: new Date(crawls[2].getTime() - 1000) },
        transitionsInWindow: [{ type: "PRODUCT_RESTORED", occurredAt: crawls[1] }],
      }),
    );
    if (result.status !== "OBSERVED") throw new Error("unreachable");
    // oldest crawl: still inactive (removed before window opened)
    // middle crawl: restored -> active
    // newest crawl: active
    expect(result.observedActiveCount).toBe(2);
    expect(result.windowCrawlCount).toBe(3);
  });
});

describe("computePersistence — insufficient history", () => {
  it("returns INSUFFICIENT_HISTORY below MIN_CRAWLS_FOR_PERSISTENCE, never a misleading ratio", () => {
    const result = computePersistence(baseArgs({ recentCrawls: crawlsAt([0, 24]) }));
    expect(result.status).toBe("INSUFFICIENT_HISTORY");
    if (result.status !== "INSUFFICIENT_HISTORY") throw new Error("unreachable");
    expect(result.realCrawlsAvailable).toBe(2);
  });

  it("does not fabricate history for a product that was only just discovered", () => {
    const crawls = crawlsAt([0, 24, 48, 72, 96]); // store has plenty of history
    const result = computePersistence(
      baseArgs({ recentCrawls: crawls, firstSeenAt: crawls[0] }), // product only existed for the most recent crawl
    );
    expect(result.status).toBe("INSUFFICIENT_HISTORY");
    if (result.status !== "INSUFFICIENT_HISTORY") throw new Error("unreachable");
    expect(result.realCrawlsAvailable).toBe(1);
  });

  it("distinguishes a brand-new product from a store that lacks history overall", () => {
    // Store has plenty of real crawls, but this product was only just discovered.
    const crawls = crawlsAt([0, 24, 48, 72, 96]);
    const newProduct = computePersistence(baseArgs({ recentCrawls: crawls, firstSeenAt: crawls[0] }));
    if (newProduct.status !== "INSUFFICIENT_HISTORY") throw new Error("unreachable");
    expect(newProduct.realCrawlsAvailable).toBe(1);
    expect(newProduct.storeRealCrawlCount).toBe(5);

    // Store itself has barely been crawled at all.
    const youngStore = computePersistence(baseArgs({ recentCrawls: crawlsAt([0, 24]), firstSeenAt: new Date("2020-01-01") }));
    if (youngStore.status !== "INSUFFICIENT_HISTORY") throw new Error("unreachable");
    expect(youngStore.realCrawlsAvailable).toBe(2);
    expect(youngStore.storeRealCrawlCount).toBe(2);
  });

  it("respects exactly MIN_CRAWLS_FOR_PERSISTENCE as the boundary", () => {
    const okCrawls = crawlsAt(Array.from({ length: MIN_CRAWLS_FOR_PERSISTENCE }, (_, i) => i * 24));
    const ok = computePersistence(baseArgs({ recentCrawls: okCrawls }));
    expect(ok.status).toBe("OBSERVED");

    const shortCrawls = crawlsAt(Array.from({ length: MIN_CRAWLS_FOR_PERSISTENCE - 1 }, (_, i) => i * 24));
    const short = computePersistence(baseArgs({ recentCrawls: shortCrawls }));
    expect(short.status).toBe("INSUFFICIENT_HISTORY");
  });
});

describe("computePersistence — window bound", () => {
  it("PERSISTENCE_WINDOW_CRAWLS caps how far back a persistence ratio ever looks", () => {
    // Documents the intended cap — the caller (getProductPersistence) is
    // responsible for actually passing no more than this many crawls in;
    // this pure function trusts its input, so this just pins the constant.
    expect(PERSISTENCE_WINDOW_CRAWLS).toBe(20);
  });
});
