import { describe, expect, it } from "vitest";
import { diffAds } from "../diff";
import type { ObservedAd, PreviousAdState } from "../types";

const NOW = new Date("2026-08-11T12:00:00Z");
const STORE_ID = "store1";

function observed(overrides: Partial<ObservedAd> = {}): ObservedAd {
  return {
    externalAdId: "CR001",
    destinationUrl: "https://example.com/products/blue-shirt",
    advertiserExternalId: "AR001",
    advertiserName: "Acme Inc",
    format: "text",
    sourceMetadata: null,
    matchedProductId: null,
    matchMethod: null,
    matchConfidence: null,
    ...overrides,
  };
}

function previous(overrides: Partial<PreviousAdState> = {}): PreviousAdState {
  return {
    id: "ad1",
    externalAdId: "CR001",
    destinationUrl: "https://example.com/products/blue-shirt",
    advertiserExternalId: "AR001",
    advertiserName: "Acme Inc",
    format: "text",
    status: "ACTIVE_EVIDENCE",
    missingStreak: 0,
    matchedProductId: null,
    matchMethod: null,
    matchConfidence: null,
    firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function run(args: { previous?: PreviousAdState[]; observed?: ObservedAd[]; isBaseline?: boolean; removalConfirmations?: number }) {
  return diffAds({
    storeId: STORE_ID,
    platform: "GOOGLE",
    previous: args.previous ?? [],
    observed: args.observed ?? [],
    now: NOW,
    isBaseline: args.isBaseline ?? false,
    removalConfirmations: args.removalConfirmations ?? 2,
  });
}

describe("diffAds — new ad detection", () => {
  it("emits AD_DETECTED for a brand-new ad and inserts it ACTIVE_EVIDENCE", () => {
    const result = run({ observed: [observed()] });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventType: "AD_DETECTED", entityType: "AD" });
    expect(result.upserts).toEqual([
      expect.objectContaining({ adId: null, externalAdId: "CR001", status: "ACTIVE_EVIDENCE", missingStreak: 0 }),
    ]);
  });

  it("suppresses AD_DETECTED on the store's baseline collection, but still persists the ad", () => {
    const result = run({ observed: [observed()], isBaseline: true });

    expect(result.events).toHaveLength(0);
    expect(result.upserts).toHaveLength(1);
  });

  it("also emits PRODUCT_AD_MATCHED when a brand-new ad arrives already matched", () => {
    const result = run({
      observed: [observed({ matchedProductId: "p1", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" })],
    });

    const types = result.events.map((e) => e.eventType);
    expect(types).toContain("AD_DETECTED");
    expect(types).toContain("PRODUCT_AD_MATCHED");
  });

  it("re-running the identical collection cycle does not duplicate the detection event (same dedupeKey)", () => {
    const first = run({ observed: [observed()] });
    const second = run({ observed: [observed()] });
    expect(first.events[0].dedupeKey).toBe(second.events[0].dedupeKey);
  });
});

describe("diffAds — unchanged ad", () => {
  it("emits nothing for an ad seen again with identical fields", () => {
    const result = run({ previous: [previous()], observed: [observed()] });
    expect(result.events).toHaveLength(0);
    expect(result.upserts[0]).toMatchObject({ adId: "ad1", missingStreak: 0, status: "ACTIVE_EVIDENCE" });
  });
});

describe("diffAds — AD_CHANGED", () => {
  it("emits AD_CHANGED when the destination URL changes", () => {
    const result = run({
      previous: [previous()],
      observed: [observed({ destinationUrl: "https://example.com/products/red-hat" })],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventType: "AD_CHANGED" });
  });

  it("emits AD_CHANGED when the advertiser name changes", () => {
    const result = run({ previous: [previous()], observed: [observed({ advertiserName: "Acme Holdings" })] });
    expect(result.events.map((e) => e.eventType)).toEqual(["AD_CHANGED"]);
  });

  it("emits AD_CHANGED when the format changes", () => {
    const result = run({ previous: [previous()], observed: [observed({ format: "video" })] });
    expect(result.events.map((e) => e.eventType)).toEqual(["AD_CHANGED"]);
  });

  it("does NOT emit AD_CHANGED for a match-only difference (that's PRODUCT_AD_MATCHED's job)", () => {
    const result = run({
      previous: [previous({ matchedProductId: null })],
      observed: [observed({ matchedProductId: "p1", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" })],
    });
    expect(result.events.map((e) => e.eventType)).toEqual(["PRODUCT_AD_MATCHED"]);
  });

  it("a repeated identical change does not double-fire, but a further DIFFERENT change does", () => {
    const changed = observed({ destinationUrl: "https://example.com/products/red-hat" });
    const first = run({ previous: [previous()], observed: [changed] });

    const prevAfterChange = previous({ destinationUrl: "https://example.com/products/red-hat" });
    const repeat = run({ previous: [prevAfterChange], observed: [changed] });
    expect(repeat.events).toHaveLength(0); // no change vs. this "previous" -> nothing fires

    const furtherChange = observed({ destinationUrl: "https://example.com/products/green-scarf" });
    const second = run({ previous: [prevAfterChange], observed: [furtherChange] });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].dedupeKey).not.toBe(first.events[0].dedupeKey);
  });

  it("suppresses AD_CHANGED on baseline", () => {
    const result = run({
      previous: [previous()],
      observed: [observed({ destinationUrl: "https://example.com/products/red-hat" })],
      isBaseline: true,
    });
    expect(result.events).toHaveLength(0);
  });
});

describe("diffAds — absence / removal (flap suppression)", () => {
  it("a single missed check does not remove the ad — missingStreak increments, status stays ACTIVE_EVIDENCE", () => {
    const result = run({ previous: [previous()], observed: [] });

    expect(result.events).toHaveLength(0); // not confirmed yet — no AD_REMOVED
    expect(result.upserts[0]).toMatchObject({ status: "ACTIVE_EVIDENCE", missingStreak: 1 });
  });

  it("confirms removal only after removalConfirmations consecutive absences", () => {
    const onceGone = previous({ missingStreak: 1 });
    const result = run({ previous: [onceGone], observed: [], removalConfirmations: 2 });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventType: "AD_REMOVED" });
    expect(result.upserts[0]).toMatchObject({ status: "HISTORICAL", missingStreak: 2 });
  });

  it("does not re-fire AD_REMOVED for an ad already HISTORICAL", () => {
    const alreadyHistorical = previous({ status: "HISTORICAL", missingStreak: 5 });
    const result = run({ previous: [alreadyHistorical], observed: [], removalConfirmations: 2 });
    expect(result.events).toHaveLength(0);
  });

  it("suppresses AD_REMOVED on baseline", () => {
    const onceGone = previous({ missingStreak: 1 });
    const result = run({ previous: [onceGone], observed: [], removalConfirmations: 2, isBaseline: true });
    expect(result.events).toHaveLength(0);
  });

  it("a failed collection run is never fed into diffAds as an empty observed set implicitly — this function only reflects what it's given", () => {
    // Guard against the "silently downgrade an unavailable source into an
    // empty result" failure mode: diffAds() has no special-case for
    // "vendor was unreachable" — that decision must be made by the caller
    // BEFORE invoking diffAds() at all (never call it on a failed run).
    const result = run({ previous: [previous()], observed: [] });
    expect(result.upserts[0].missingStreak).toBe(1); // proves observed:[] IS treated as "checked, not found"
  });
});

describe("diffAds — reappearance after confirmed removal", () => {
  it("re-emits AD_DETECTED (day-bucketed) when a HISTORICAL ad reappears", () => {
    const historical = previous({ status: "HISTORICAL", missingStreak: 3 });
    const result = run({ previous: [historical], observed: [observed()] });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventType: "AD_DETECTED" });
    expect(result.upserts[0]).toMatchObject({ status: "ACTIVE_EVIDENCE", missingStreak: 0 });
  });

  it("the reappearance dedupeKey differs from the original first-detection dedupeKey", () => {
    const brandNew = run({ observed: [observed()] });
    const historical = previous({ status: "HISTORICAL", missingStreak: 3 });
    const reappeared = run({ previous: [historical], observed: [observed()] });

    expect(reappeared.events[0].dedupeKey).not.toBe(brandNew.events[0].dedupeKey);
  });
});

describe("diffAds — re-matching to a different product", () => {
  it("fires PRODUCT_AD_MATCHED again when an existing ad's match changes to a different product", () => {
    const prev = previous({ matchedProductId: "p1", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" });
    const result = run({
      previous: [prev],
      observed: [observed({ matchedProductId: "p2", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" })],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventType: "PRODUCT_AD_MATCHED", newValue: { productId: "p2" } });
  });

  it("does not re-fire when the match is unchanged", () => {
    const prev = previous({ matchedProductId: "p1", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" });
    const result = run({
      previous: [prev],
      observed: [observed({ matchedProductId: "p1", matchMethod: "EXACT_PRODUCT_URL", matchConfidence: "HIGH" })],
    });
    expect(result.events).toHaveLength(0);
  });
});
