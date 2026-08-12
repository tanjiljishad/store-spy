import type { StoreContext } from "../crawl/types";
import { dayBucket, makeDedupeKey, type DraftEvent, type EventType } from "../diff/events";
import { scoreEvent } from "../diff/significance";
import type { AdObservationStatus, AdPlatform, MatchConfidence, MatchMethod, ObservedAd, PreviousAdState } from "./types";

/**
 * Pure diff for advertising evidence, same contract and shape as
 * diffEntitySet() (src/lib/diff/entities.ts): no IO, deterministic in its
 * inputs. Identity is the vendor's externalAdId — NEVER the destination
 * URL — because multiple ads can legitimately point at the same product.
 *
 * Two states, not three: AdObservationStatus collapses StoreEntity's
 * ACTIVE -> MISSING -> REMOVED into ACTIVE_EVIDENCE -> HISTORICAL. A single
 * missed poll is not yet meaningful for an ad the way it is for a product —
 * missingStreak still climbs while status stays ACTIVE_EVIDENCE, and only
 * flips to HISTORICAL once removalConfirmations is reached. Never confirmed
 * on a failed/UNAVAILABLE collection run — this function is only ever
 * called with data from a run that outcome=SUCCESS, so "observed" here
 * always means "the vendor was actually checked and this is what it said."
 */

export interface AdUpsert {
  adId: string | null; // null = insert
  externalAdId: string;
  advertiserExternalId: string | null;
  advertiserName: string | null;
  destinationUrl: string | null;
  format: string | null;
  sourceMetadata: Record<string, unknown> | null;
  status: AdObservationStatus;
  missingStreak: number;
  matchedProductId: string | null;
  matchMethod: MatchMethod | null;
  matchConfidence: MatchConfidence | null;
  firstSeenAt: Date;
  /** null on the removal path — deliberately not touched, same as ProductUpsert/EntityUpsert. */
  lastSeenAt: Date | null;
}

export interface DiffAdsInput {
  storeId: string;
  platform: AdPlatform;
  previous: PreviousAdState[];
  observed: ObservedAd[];
  now: Date;
  /** True on the store's first-ever successful collection — ads are persisted but emit no events. */
  isBaseline: boolean;
  removalConfirmations: number;
}

export interface DiffAdsResult {
  events: DraftEvent[];
  upserts: AdUpsert[];
}

export function diffAds(input: DiffAdsInput): DiffAdsResult {
  const { storeId, platform, previous, observed, now, isBaseline, removalConfirmations } = input;
  const events: DraftEvent[] = [];
  const upserts: AdUpsert[] = [];

  const prevById = new Map(previous.map((a) => [a.externalAdId, a]));
  const seenIds = new Set(observed.map((a) => a.externalAdId));
  const previouslyActive = previous.filter((a) => a.status !== "HISTORICAL");

  // Minimal, neutral significance context. rarityFactor/relevanceFactor/
  // crossStoreFactor all no-op for AD_* event types (see significance.ts) —
  // this exists only to satisfy scoreEvent()'s signature, not because
  // marketing events read real store stats today.
  const scoringContext: StoreContext = {
    id: storeId,
    domain: "",
    currency: "",
    baselinedAt: null,
    themeName: null,
    themeVersion: null,
    entities: [],
    stats: null,
  };

  for (const o of observed) {
    const prev = prevById.get(o.externalAdId);

    if (!prev) {
      upserts.push({
        adId: null,
        externalAdId: o.externalAdId,
        advertiserExternalId: o.advertiserExternalId,
        advertiserName: o.advertiserName,
        destinationUrl: o.destinationUrl,
        format: o.format,
        sourceMetadata: o.sourceMetadata,
        status: "ACTIVE_EVIDENCE",
        missingStreak: 0,
        matchedProductId: o.matchedProductId,
        matchMethod: o.matchMethod,
        matchConfidence: o.matchConfidence,
        firstSeenAt: now,
        lastSeenAt: now,
      });

      if (!isBaseline) {
        events.push(
          adDraft({
            storeId,
            platform,
            externalAdId: o.externalAdId,
            eventType: "AD_DETECTED",
            oldValue: null,
            newValue: adSnapshotValue(o),
            now,
            scoringContext,
            // Fires once, ever, for this ad — constant discriminator so a
            // collection retry can't double-fire it.
            discriminator: `${o.externalAdId}:detected`,
          }),
        );
        if (o.matchedProductId) {
          events.push(
            matchDraft({ storeId, platform, externalAdId: o.externalAdId, productId: o.matchedProductId, now, scoringContext }),
          );
        }
      }
      continue;
    }

    upserts.push({
      adId: prev.id,
      externalAdId: o.externalAdId,
      advertiserExternalId: o.advertiserExternalId,
      advertiserName: o.advertiserName,
      destinationUrl: o.destinationUrl,
      format: o.format,
      sourceMetadata: o.sourceMetadata,
      status: "ACTIVE_EVIDENCE",
      missingStreak: 0,
      matchedProductId: o.matchedProductId,
      matchMethod: o.matchMethod,
      matchConfidence: o.matchConfidence,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: now,
    });

    if (isBaseline) continue;

    if (prev.status === "HISTORICAL") {
      // Reappearance after a confirmed removal. Same asymmetry as
      // diffEntitySet(): only a *confirmed* removal is worth alerting on
      // the way back, and it's day-bucketed so a later genuine reinstall
      // can still fire, unlike the one-time "brand new" event above.
      events.push(
        adDraft({
          storeId,
          platform,
          externalAdId: o.externalAdId,
          eventType: "AD_DETECTED",
          oldValue: null,
          newValue: adSnapshotValue(o),
          now,
          scoringContext,
          discriminator: `${o.externalAdId}:detected:${dayBucket(now)}`,
        }),
      );
    } else if (hasMeaningfulChange(prev, o)) {
      events.push(
        adDraft({
          storeId,
          platform,
          externalAdId: o.externalAdId,
          eventType: "AD_CHANGED",
          oldValue: adSnapshotValue(prev),
          newValue: adSnapshotValue(o),
          now,
          scoringContext,
          // Discriminator encodes the new values: a repeat crawl with the
          // identical new state dedupes, but a later DIFFERENT change still
          // fires its own event.
          discriminator: `${o.externalAdId}:changed:${o.destinationUrl}|${o.advertiserExternalId}|${o.format}`,
        }),
      );
    }

    if (o.matchedProductId && o.matchedProductId !== prev.matchedProductId) {
      events.push(
        matchDraft({ storeId, platform, externalAdId: o.externalAdId, productId: o.matchedProductId, now, scoringContext }),
      );
    }
  }

  for (const prev of previouslyActive) {
    if (seenIds.has(prev.externalAdId)) continue;

    const streak = prev.missingStreak + 1;
    const confirmed = streak >= removalConfirmations;

    upserts.push({
      adId: prev.id,
      externalAdId: prev.externalAdId,
      advertiserExternalId: prev.advertiserExternalId,
      advertiserName: prev.advertiserName,
      destinationUrl: prev.destinationUrl,
      format: prev.format,
      sourceMetadata: null, // not touched on the absence path — persist.ts preserves the existing value
      status: confirmed ? "HISTORICAL" : "ACTIVE_EVIDENCE",
      missingStreak: streak,
      matchedProductId: prev.matchedProductId,
      matchMethod: prev.matchMethod,
      matchConfidence: prev.matchConfidence,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: null,
    });

    if (confirmed && prev.status !== "HISTORICAL" && !isBaseline) {
      events.push(
        adDraft({
          storeId,
          platform,
          externalAdId: prev.externalAdId,
          eventType: "AD_REMOVED",
          oldValue: adSnapshotValue(prev),
          newValue: null,
          now,
          scoringContext,
          discriminator: `${prev.externalAdId}:removed`,
        }),
      );
    }
  }

  return { events, upserts };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Only fields the vendor actually reports about the ad itself — never
 * matching-derived fields (those get their own PRODUCT_AD_MATCHED event)
 * and never sourceMetadata (debugging aid, not a meaningful ad property).
 */
function hasMeaningfulChange(prev: PreviousAdState, observed: ObservedAd): boolean {
  return (
    prev.destinationUrl !== observed.destinationUrl ||
    prev.advertiserExternalId !== observed.advertiserExternalId ||
    prev.advertiserName !== observed.advertiserName ||
    prev.format !== observed.format
  );
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

function adSnapshotValue(ad: { destinationUrl: string | null; advertiserExternalId: string | null; advertiserName: string | null; format: string | null }) {
  return {
    destinationUrl: ad.destinationUrl,
    advertiserExternalId: ad.advertiserExternalId,
    advertiserName: ad.advertiserName,
    format: ad.format,
  };
}

const AD_EVENT_MAGNITUDE = 0.5; // flat, neutral — no per-instance signal (rank/price) exists for ads yet

function adDraft(args: {
  storeId: string;
  platform: AdPlatform;
  externalAdId: string;
  eventType: EventType;
  oldValue: unknown;
  newValue: unknown;
  now: Date;
  scoringContext: StoreContext;
  discriminator: string;
}): DraftEvent {
  const { storeId, platform, externalAdId, eventType, oldValue, newValue, now, scoringContext, discriminator } = args;
  const entityKey = adEntityKey(platform, externalAdId);
  return {
    entityType: "AD",
    entityKey,
    eventType,
    oldValue,
    newValue,
    headline: headlineFor(eventType, newValue),
    significance: scoreEvent({ eventType, store: scoringContext, magnitude: AD_EVENT_MAGNITUDE }),
    backfilled: false,
    occurredAt: now,
    dedupeKey: makeDedupeKey({ storeId, entityKey, eventType, discriminator }),
  };
}

function matchDraft(args: {
  storeId: string;
  platform: AdPlatform;
  externalAdId: string;
  productId: string;
  now: Date;
  scoringContext: StoreContext;
}): DraftEvent {
  const { storeId, platform, externalAdId, productId, now, scoringContext } = args;
  const entityKey = adEntityKey(platform, externalAdId);
  return {
    entityType: "AD",
    entityKey,
    eventType: "PRODUCT_AD_MATCHED",
    oldValue: null,
    newValue: { productId },
    headline: "Ad matched to a product in your catalog",
    significance: scoreEvent({ eventType: "PRODUCT_AD_MATCHED", store: scoringContext, magnitude: AD_EVENT_MAGNITUDE }),
    backfilled: false,
    occurredAt: now,
    dedupeKey: makeDedupeKey({ storeId, entityKey, eventType: "PRODUCT_AD_MATCHED", discriminator: `${externalAdId}:matched:${productId}` }),
  };
}

function adEntityKey(platform: AdPlatform, externalAdId: string): string {
  return `${platform.toLowerCase()}:${externalAdId}`;
}

function headlineFor(eventType: EventType, newValue: unknown): string {
  switch (eventType) {
    case "AD_DETECTED":
      return "New ad detected";
    case "AD_REMOVED":
      return "Ad no longer running";
    case "AD_CHANGED": {
      const url = isRecordWithDestination(newValue) ? newValue.destinationUrl : null;
      return url ? `Ad changed — now points to ${url}` : "Ad changed";
    }
    default:
      return "Advertising update";
  }
}

function isRecordWithDestination(v: unknown): v is { destinationUrl: string | null } {
  return typeof v === "object" && v !== null && "destinationUrl" in v;
}
