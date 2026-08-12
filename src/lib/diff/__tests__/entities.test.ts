import { describe, expect, it } from "vitest";
import type { EntityKind, PreviousEntityState, StoreContext } from "../../crawl/types";
import { diffEntitySet, observeEntities, type ObservedEntity } from "../entities";
import type { NormalizedStoreSnapshot } from "../../crawl/types";

const NOW = new Date("2026-08-08T12:00:00Z");

function store(overrides: Partial<StoreContext> = {}): StoreContext {
  return {
    id: "store_1",
    domain: "example.com",
    currency: "USD",
    baselinedAt: new Date("2026-01-01T00:00:00Z"),
    themeName: null,
    themeVersion: null,
    entities: [],
    stats: null,
    ...overrides,
  };
}

function entity(overrides: Partial<PreviousEntityState> = {}): PreviousEntityState {
  return {
    id: "ent_1",
    kind: "COLLECTION",
    key: "some-collection",
    meta: null,
    status: "ACTIVE",
    missingStreak: 0,
    missingSince: null,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const ALL_KINDS = new Set<EntityKind>(["APP", "PIXEL", "COLLECTION", "PAYMENT_PROVIDER"]);

const types = (r: { events: Array<{ eventType: string }> }) => r.events.map((e) => e.eventType);

describe("diffEntitySet — the allbirds case", () => {
  it("200 unchanged collections in, zero events out", () => {
    const previous = Array.from({ length: 200 }, (_, i) =>
      entity({ id: `c${i}`, kind: "COLLECTION", key: `collection-${i}` }),
    );
    const observed: ObservedEntity[] = previous.map((e) => ({ kind: e.kind, key: e.key }));

    const r = diffEntitySet({
      store: store(),
      previous,
      observed,
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(r.events).toHaveLength(0);
    expect(r.upserts).toHaveLength(200);
    expect(r.upserts.every((u) => u.status === "ACTIVE" && u.missingStreak === 0)).toBe(true);
  });
});

describe("diffEntitySet — additions", () => {
  it("a genuinely new entity fires an ADDED event", () => {
    const r = diffEntitySet({
      store: store(),
      previous: [],
      observed: [{ kind: "APP", key: "klaviyo" }],
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toEqual(["APP_ADDED"]);
    expect(r.upserts[0]).toMatchObject({ entityId: null, kind: "APP", key: "klaviyo", status: "ACTIVE" });
  });

  it("baseline persists entities but emits no events", () => {
    const r = diffEntitySet({
      store: store(),
      previous: [],
      observed: [
        { kind: "APP", key: "klaviyo" },
        { kind: "COLLECTION", key: "all" },
      ],
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: true,
      removalConfirmations: 2,
    });

    expect(r.events).toHaveLength(0);
    expect(r.upserts).toHaveLength(2);
    expect(r.upserts.every((u) => u.status === "ACTIVE")).toBe(true);
  });

  it("carries pixel meta through to both the upsert and the event", () => {
    const r = diffEntitySet({
      store: store(),
      previous: [],
      observed: [{ kind: "PIXEL", key: "facebook", meta: { id: "123456789" } }],
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(r.upserts[0].meta).toEqual({ id: "123456789" });
    expect(r.events[0].newValue).toMatchObject({ id: "123456789" });
  });

  it("a new payment provider fires PAYMENT_PROVIDER_ADDED", () => {
    const r = diffEntitySet({
      store: store(),
      previous: [],
      observed: [{ kind: "PAYMENT_PROVIDER", key: "shop_pay" }],
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toEqual(["PAYMENT_PROVIDER_ADDED"]);
  });
});

describe("diffEntitySet — the flapping fix", () => {
  it("a single-crawl absence does not fire REMOVED", () => {
    const previous = [entity({ id: "e1", kind: "APP", key: "klaviyo" })];
    const r = diffEntitySet({
      store: store(),
      previous,
      observed: [], // app missing this crawl
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toHaveLength(0);
    expect(r.upserts[0]).toMatchObject({ status: "MISSING", missingStreak: 1 });
  });

  it("reappearing after an unconfirmed MISSING is completely silent — no event either way", () => {
    const previous = [entity({ id: "e1", kind: "APP", key: "klaviyo", status: "MISSING", missingStreak: 1 })];
    const r = diffEntitySet({
      store: store(),
      previous,
      observed: [{ kind: "APP", key: "klaviyo" }], // back this crawl
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toHaveLength(0); // never alerted removed, so not alerted restored
    expect(r.upserts[0]).toMatchObject({ status: "ACTIVE", missingStreak: 0 });
  });

  it("confirms removal once the streak threshold is reached, and only then", () => {
    const previous = [entity({ id: "e1", kind: "APP", key: "klaviyo", status: "MISSING", missingStreak: 1 })];
    const r = diffEntitySet({
      store: store(),
      previous,
      observed: [],
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toEqual(["APP_REMOVED"]);
    expect(r.upserts[0]).toMatchObject({ status: "REMOVED", missingStreak: 2 });
  });

  it("a genuine reinstall after a CONFIRMED removal fires ADDED again", () => {
    const previous = [entity({ id: "e1", kind: "APP", key: "klaviyo", status: "REMOVED", missingStreak: 3 })];
    const r = diffEntitySet({
      store: store(),
      previous,
      observed: [{ kind: "APP", key: "klaviyo" }],
      observedKinds: ALL_KINDS,
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toEqual(["APP_ADDED"]);
    expect(r.upserts[0]).toMatchObject({ status: "ACTIVE", missingStreak: 0 });
  });
});

describe("diffEntitySet — per-kind observation gating", () => {
  it("a kind whose data wasn't fetched is left completely untouched", () => {
    const previous = [
      entity({ id: "e1", kind: "APP", key: "klaviyo" }),
      entity({ id: "e2", kind: "COLLECTION", key: "all" }),
    ];
    const r = diffEntitySet({
      store: store(),
      previous,
      observed: [{ kind: "COLLECTION", key: "all" }], // APP's data wasn't fetched this crawl
      observedKinds: new Set<EntityKind>(["COLLECTION"]), // APP excluded
      now: NOW,
      isBaseline: false,
      removalConfirmations: 2,
    });

    expect(types(r)).toHaveLength(0);
    // Only the collection got an upsert (a no-op ACTIVE refresh); the app,
    // whose data we don't trust this crawl, produces no upsert at all —
    // its row is left exactly as it was, same as products under `partial`.
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0].kind).toBe("COLLECTION");
  });
});

describe("observeEntities", () => {
  function snap(overrides: Partial<NormalizedStoreSnapshot> = {}): NormalizedStoreSnapshot {
    return {
      domain: "example.com",
      currency: "USD",
      products: [],
      collectionHandles: [],
      hasCollectionData: true,
      tech: null,
      hasTechData: true,
      partial: false,
      pagesExpected: 1,
      pagesFetched: 1,
      httpErrors: 0,
      hasRankData: false,
      capturedAt: NOW,
      ...overrides,
    };
  }

  it("builds the observed set from tech and collectionHandles", () => {
    const { observed } = observeEntities(
      snap({
        collectionHandles: ["all", "sale"],
        tech: {
          themeName: "Dawn",
          themeVersion: null,
          apps: ["klaviyo"],
          pixels: { facebook: "111" },
          paymentProviders: ["shop_pay"],
          emailPlatform: "klaviyo",
        },
      }),
    );

    expect(observed).toContainEqual({ kind: "COLLECTION", key: "all" });
    expect(observed).toContainEqual({ kind: "COLLECTION", key: "sale" });
    expect(observed).toContainEqual({ kind: "APP", key: "klaviyo" });
    expect(observed).toContainEqual({ kind: "PIXEL", key: "facebook", meta: { id: "111" } });
    expect(observed).toContainEqual({ kind: "PAYMENT_PROVIDER", key: "shop_pay" });
    // emailPlatform is intentionally not a set member — not observed as an entity.
    expect(observed.some((o) => o.kind === "EMAIL_PLATFORM")).toBe(false);
  });

  it("gates APP/PIXEL/PAYMENT_PROVIDER together on hasTechData, COLLECTION separately on hasCollectionData", () => {
    const { observedKinds } = observeEntities(snap({ hasTechData: false, hasCollectionData: true }));
    expect(observedKinds.has("APP")).toBe(false);
    expect(observedKinds.has("PIXEL")).toBe(false);
    expect(observedKinds.has("PAYMENT_PROVIDER")).toBe(false);
    expect(observedKinds.has("COLLECTION")).toBe(true);

    const { observedKinds: reversed } = observeEntities(snap({ hasTechData: true, hasCollectionData: false }));
    expect(reversed.has("APP")).toBe(true);
    expect(reversed.has("COLLECTION")).toBe(false);
  });
});
