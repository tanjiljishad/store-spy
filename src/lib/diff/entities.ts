import type { EntityKind, NormalizedStoreSnapshot, PreviousEntityState, StoreContext } from "../crawl/types";
import { dayBucket, makeDedupeKey, type DraftEvent, type EntityType, type EventType } from "./events";
import { scoreEvent } from "./significance";

/**
 * Generic diff for "a named thing that appears, persists, and disappears":
 * apps, pixels, collections, payment providers. Same state machine as
 * products (ACTIVE -> MISSING -> REMOVED, confirmed over N crawls) for the
 * same reason products need it — fingerprinting off HTML is inherently
 * flappy, and a script tag missing from one homepage fetch is not a removal.
 *
 * PURE, same contract as diffStore(): no IO, deterministic in its inputs.
 */

export interface ObservedEntity {
  kind: EntityKind;
  key: string;
  meta?: Record<string, unknown>;
}

export interface EntityUpsert {
  entityId: string | null; // null = insert
  kind: EntityKind;
  key: string;
  meta: Record<string, unknown> | null;
  status: "ACTIVE" | "MISSING" | "REMOVED";
  missingStreak: number;
  missingSince: Date | null;
  /** null on the removal path — deliberately not touched, same as ProductUpsert. */
  lastSeenAt: Date | null;
}

export interface DiffEntitySetInput {
  store: StoreContext;
  previous: PreviousEntityState[];
  observed: ObservedEntity[];
  /**
   * Which kinds were actually fetched this crawl. A kind absent here is
   * treated exactly like snapshot.partial for products: additions still
   * process (an app can only be OBSERVED if its data was fetched, so there's
   * nothing to wrongly add), but absence proves nothing — streaks are left
   * untouched and nothing transitions toward REMOVED.
   */
  observedKinds: Set<EntityKind>;
  now: Date;
  /** Baseline crawls persist entities but never emit alertable events. */
  isBaseline: boolean;
  removalConfirmations: number;
}

export interface DiffEntitySetResult {
  events: DraftEvent[];
  upserts: EntityUpsert[];
}

export function diffEntitySet(input: DiffEntitySetInput): DiffEntitySetResult {
  const { store, previous, observed, observedKinds, now, isBaseline, removalConfirmations } = input;
  const events: DraftEvent[] = [];
  const upserts: EntityUpsert[] = [];

  const prevByMapKey = new Map(previous.map((e) => [mapKey(e.kind, e.key), e]));
  const seenMapKeys = new Set(observed.map((o) => mapKey(o.kind, o.key)));
  const previouslyActive = previous.filter((e) => e.status !== "REMOVED");

  for (const o of observed) {
    const prev = prevByMapKey.get(mapKey(o.kind, o.key));
    const meta = o.meta ?? null;

    if (!prev) {
      upserts.push({
        entityId: null,
        kind: o.kind,
        key: o.key,
        meta,
        status: "ACTIVE",
        missingStreak: 0,
        missingSince: null,
        lastSeenAt: now,
      });
      if (!isBaseline) {
        events.push(
          entityDraft({
            store,
            kind: o.kind,
            key: o.key,
            meta,
            added: true,
            now,
            // Fires once, ever, for this key — constant discriminator so a
            // crawl retry can't double-fire it.
            discriminator: `${o.key}:added`,
          }),
        );
      }
      continue;
    }

    upserts.push({
      entityId: prev.id,
      kind: o.kind,
      key: o.key,
      meta,
      status: "ACTIVE",
      missingStreak: 0,
      missingSince: null,
      lastSeenAt: now,
    });

    // Only a *confirmed* removal (status REMOVED) is worth an event on the
    // way back. A single-crawl flap that never reached MISSING's streak
    // threshold was never alerted as gone, so it should not be alerted as
    // back either — that symmetry is the actual fix for the flapping bug.
    if (prev.status === "REMOVED" && !isBaseline) {
      events.push(
        entityDraft({
          store,
          kind: o.kind,
          key: o.key,
          meta,
          added: true,
          now,
          // Day-bucketed: a genuine reinstall later must still be able to
          // fire, unlike the one-time "brand new" event above.
          discriminator: `${o.key}:added:${dayBucket(now)}`,
        }),
      );
    }
  }

  for (const prev of previouslyActive) {
    if (seenMapKeys.has(mapKey(prev.kind, prev.key))) continue;
    if (!observedKinds.has(prev.kind)) continue; // this kind's data wasn't fetched — don't touch

    const streak = prev.missingStreak + 1;
    const confirmed = streak >= removalConfirmations;

    upserts.push({
      entityId: prev.id,
      kind: prev.kind,
      key: prev.key,
      meta: null,
      status: confirmed ? "REMOVED" : "MISSING",
      missingStreak: streak,
      missingSince: prev.missingSince ?? now,
      lastSeenAt: null,
    });

    if (confirmed && prev.status !== "REMOVED" && !isBaseline) {
      events.push(
        entityDraft({
          store,
          kind: prev.kind,
          key: prev.key,
          meta: null,
          added: false,
          now,
          discriminator: `${prev.key}:removed`,
        }),
      );
    }
  }

  return { events, upserts };
}

/**
 * Maps a snapshot onto the observed set diffEntitySet() expects, plus which
 * kinds actually have trustworthy data this crawl. hasTechData gates
 * APP/PIXEL/PAYMENT_PROVIDER together because all three come from the same
 * homepage fetch; hasCollectionData gates COLLECTION separately because it
 * comes from a different endpoint that fails independently.
 *
 * EMAIL_PLATFORM is a scalar (one ESP, if any), not a set — intentionally
 * not observed here. Reserved in the schema for when that gets wired up.
 */
export function observeEntities(snapshot: NormalizedStoreSnapshot): {
  observed: ObservedEntity[];
  observedKinds: Set<EntityKind>;
} {
  const observed: ObservedEntity[] = [
    ...(snapshot.tech?.apps ?? []).map((k) => ({ kind: "APP" as const, key: k })),
    ...Object.entries(snapshot.tech?.pixels ?? {}).map(([k, id]) => ({
      kind: "PIXEL" as const,
      key: k,
      meta: { id },
    })),
    ...(snapshot.tech?.paymentProviders ?? []).map((k) => ({ kind: "PAYMENT_PROVIDER" as const, key: k })),
    ...snapshot.collectionHandles.map((k) => ({ kind: "COLLECTION" as const, key: k })),
  ];

  const observedKinds = new Set<EntityKind>();
  if (snapshot.hasTechData) {
    observedKinds.add("APP");
    observedKinds.add("PIXEL");
    observedKinds.add("PAYMENT_PROVIDER");
  }
  if (snapshot.hasCollectionData) observedKinds.add("COLLECTION");

  return { observed, observedKinds };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapKey(kind: EntityKind, key: string): string {
  return `${kind}:${key}`;
}

function entityTypeFor(kind: EntityKind): EntityType {
  return kind === "COLLECTION" ? "COLLECTION" : "TECH";
}

function eventTypeFor(kind: EntityKind, added: boolean): EventType {
  switch (kind) {
    case "APP":
      return added ? "APP_ADDED" : "APP_REMOVED";
    case "PIXEL":
      return added ? "PIXEL_ADDED" : "PIXEL_REMOVED";
    case "COLLECTION":
      return added ? "COLLECTION_ADDED" : "COLLECTION_REMOVED";
    case "PAYMENT_PROVIDER":
      return added ? "PAYMENT_PROVIDER_ADDED" : "PAYMENT_PROVIDER_REMOVED";
    case "EMAIL_PLATFORM":
      // Never reaches here — observeEntities() never emits EMAIL_PLATFORM.
      throw new Error("EMAIL_PLATFORM is not wired into diffEntitySet");
  }
}

function magnitudeFor(kind: EntityKind): number {
  switch (kind) {
    case "PIXEL":
      return 0.85; // new pixel = new ad channel = they are scaling
    case "APP":
      return 0.7;
    case "PAYMENT_PROVIDER":
      return 0.6;
    case "COLLECTION":
      return 0.6;
    case "EMAIL_PLATFORM":
      return 0.5;
  }
}

function headlineFor(kind: EntityKind, key: string, added: boolean): string {
  switch (kind) {
    case "COLLECTION":
      return added ? `New collection: ${key}` : `Collection removed: ${key}`;
    case "APP":
      return added ? `Installed ${key}` : `Removed ${key}`;
    case "PIXEL":
      return added
        ? `Added ${key} pixel — likely opening a new ad channel`
        : `Removed ${key} pixel`;
    case "PAYMENT_PROVIDER":
      return added ? `Added ${key} at checkout` : `Removed ${key} from checkout`;
    case "EMAIL_PLATFORM":
      return added ? `${key} added` : `${key} removed`;
  }
}

function entityDraft(args: {
  store: StoreContext;
  kind: EntityKind;
  key: string;
  meta: Record<string, unknown> | null;
  added: boolean;
  now: Date;
  discriminator: string;
}): DraftEvent {
  const { store, kind, key, meta, added, now, discriminator } = args;
  const eventType = eventTypeFor(kind, added);
  return {
    entityType: entityTypeFor(kind),
    entityKey: kind === "PIXEL" ? `pixel:${key}` : key,
    eventType,
    oldValue: added ? null : { key },
    newValue: added ? { key, ...(meta ?? {}) } : null,
    headline: headlineFor(kind, key, added),
    significance: scoreEvent({ eventType, store, magnitude: magnitudeFor(kind) }),
    backfilled: false,
    occurredAt: now,
    dedupeKey: makeDedupeKey({ storeId: store.id, entityKey: key, eventType, discriminator }),
  };
}
