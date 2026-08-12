import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { collectAdsForStore } from "./collect";
import { diffAds } from "./diff";
import type { MarketingAdSource, PreviousAdState } from "./types";

/**
 * Orchestrates one collect->diff->persist cycle for a store's marketing
 * intelligence, parallel to diff/persist.ts's runDiffAndPersist() but for
 * the independent Google-ads pipeline. Deliberately NOT merged into that
 * function or its transaction: this hits a paid external vendor and must
 * never block or slow down the Shopify analysis path (see AGENTS.md
 * performance requirements) — it runs on its own schedule via
 * marketing/scheduler.ts.
 *
 * Failure semantics are load-bearing here, not incidental:
 *   - vendor unreachable / malformed / no-advertiser-found -> the
 *     MarketingCollectionRun row records UNAVAILABLE and NO AdObservation
 *     row is touched. diffAds() is never even called on a failed run —
 *     collection failure must never be converted into "no ads found."
 *   - vendor reachable, zero ads returned -> diffAds() runs normally, which
 *     is exactly the mechanism that correctly produces zero AD_DETECTED
 *     events and, if ads existed before, AD_REMOVED once confirmed.
 */

const DEFAULT_REMOVAL_CONFIRMATIONS = 2; // matches DEFAULT_DIFF_CONFIG.removalConfirmations

export interface RunMarketingCollectionArgs {
  prisma: PrismaClient;
  storeId: string;
  source: MarketingAdSource;
  now?: Date;
  removalConfirmations?: number;
}

export type MarketingCollectionOutcome =
  | { outcome: "SUCCESS"; adsObserved: number; eventsWritten: number; vendorRequestCount: number }
  | { outcome: "UNAVAILABLE"; reason: string; vendorRequestCount: number };

export async function runMarketingCollection(
  args: RunMarketingCollectionArgs,
): Promise<MarketingCollectionOutcome> {
  const { prisma, storeId, source } = args;
  const now = args.now ?? new Date();
  const removalConfirmations = args.removalConfirmations ?? DEFAULT_REMOVAL_CONFIRMATIONS;

  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { domain: true, marketingBaselinedAt: true },
  });

  const [previousRows, products] = await Promise.all([
    prisma.adObservation.findMany({
      where: { storeId, platform: source.platform },
      select: {
        id: true,
        externalAdId: true,
        destinationUrl: true,
        advertiserExternalId: true,
        advertiserName: true,
        format: true,
        status: true,
        missingStreak: true,
        matchedProductId: true,
        matchMethod: true,
        matchConfidence: true,
        firstSeenAt: true,
      },
    }),
    prisma.product.findMany({ where: { storeId, status: "ACTIVE" }, select: { id: true, handle: true } }),
  ]);
  const previous = previousRows as unknown as PreviousAdState[];

  // Created RUNNING-equivalent (outcome: null) before the vendor call, same
  // reason Crawl rows are created before crawlShopifyStore() runs: a worker
  // that crashes mid-collection leaves a visible, honest "never finished"
  // row instead of silence.
  const runRow = await prisma.marketingCollectionRun.create({
    data: { storeId, platform: source.platform, startedAt: now },
  });

  const collected = await collectAdsForStore({ source, domain: store.domain, previous, products });

  if (collected.outcome !== "SUCCESS") {
    const reason =
      collected.outcome === "NO_ADVERTISER_FOUND"
        ? "advertiser identification unavailable — no matching advertiser record found for this domain"
        : collected.reason;

    await prisma.marketingCollectionRun.update({
      where: { id: runRow.id },
      data: { finishedAt: now, outcome: "UNAVAILABLE", reason, vendorRequestCount: collected.requestCount },
    });

    return { outcome: "UNAVAILABLE", reason, vendorRequestCount: collected.requestCount };
  }

  const isBaseline = store.marketingBaselinedAt === null;
  const diffResult = diffAds({
    storeId,
    platform: source.platform,
    previous,
    observed: collected.ads,
    now,
    isBaseline,
    removalConfirmations,
  });

  let eventsWritten = 0;

  await prisma.$transaction(
    async (tx) => {
      if (diffResult.upserts.length > 0) {
        const adIds = diffResult.upserts.map((u) => u.adId ?? randomUUID());

        const rows = diffResult.upserts.map((u, i) => ({
          id: adIds[i],
          externalAdId: u.externalAdId,
          advertiserExternalId: u.advertiserExternalId,
          advertiserName: u.advertiserName,
          destinationUrl: u.destinationUrl,
          format: u.format,
          sourceMetadata: u.sourceMetadata,
          status: u.status,
          missingStreak: u.missingStreak,
          matchedProductId: u.matchedProductId,
          matchMethod: u.matchMethod,
          matchConfidence: u.matchConfidence,
          lastSeenAt: u.lastSeenAt,
        }));

        // Same bulk-upsert shape and AT TIME ZONE 'UTC' discipline as the
        // Product/StoreEntity upserts in diff/persist.ts — see the comment
        // there for why the cast is load-bearing, not decorative.
        await tx.$executeRaw`
          INSERT INTO "AdObservation" (
            id, "storeId", platform, "externalAdId", "advertiserExternalId", "advertiserName",
            "destinationUrl", format, "sourceMetadata", status, "missingStreak",
            "matchedProductId", "matchMethod", "matchConfidence",
            "firstSeenAt", "lastSeenAt", source, "createdAt", "updatedAt"
          )
          SELECT
            x.id, ${storeId}, ${source.platform}::"AdPlatform", x."externalAdId", x."advertiserExternalId", x."advertiserName",
            x."destinationUrl", x.format, x."sourceMetadata", x.status::"AdObservationStatus", x."missingStreak",
            x."matchedProductId", x."matchMethod"::"MatchMethod", x."matchConfidence"::"MatchConfidence",
            (${now}::timestamptz AT TIME ZONE 'UTC'),
            COALESCE((x."lastSeenAt" AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC')),
            ${source.source}, (${now}::timestamptz AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC')
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
            id text, "externalAdId" text, "advertiserExternalId" text, "advertiserName" text,
            "destinationUrl" text, format text, "sourceMetadata" jsonb, status text, "missingStreak" int,
            "matchedProductId" text, "matchMethod" text, "matchConfidence" text,
            "lastSeenAt" timestamptz
          )
          ON CONFLICT ("storeId", platform, "externalAdId") DO UPDATE SET
            "advertiserExternalId" = EXCLUDED."advertiserExternalId",
            "advertiserName" = EXCLUDED."advertiserName",
            "destinationUrl" = EXCLUDED."destinationUrl",
            format = EXCLUDED.format,
            -- Cost control means a "cached, unchanged" cycle deliberately
            -- sends no fresh sourceMetadata (see collect.ts) — COALESCE
            -- keeps the last real value instead of erasing it with null.
            "sourceMetadata" = COALESCE(EXCLUDED."sourceMetadata", "AdObservation"."sourceMetadata"),
            status = EXCLUDED.status,
            "missingStreak" = EXCLUDED."missingStreak",
            "matchedProductId" = EXCLUDED."matchedProductId",
            "matchMethod" = EXCLUDED."matchMethod",
            "matchConfidence" = EXCLUDED."matchConfidence",
            source = ${source.source},
            "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC'),
            -- lastSeenAt only advances on a genuine ACTIVE_EVIDENCE
            -- observation this cycle — the absence path sends lastSeenAt:
            -- null (see diff.ts), substituted to ${now} above, so status is
            -- the only reliable signal distinguishing the two here.
            "lastSeenAt" = CASE WHEN EXCLUDED.status = 'ACTIVE_EVIDENCE'
                                THEN EXCLUDED."lastSeenAt"
                                ELSE "AdObservation"."lastSeenAt" END
        `;
      }

      if (diffResult.events.length > 0) {
        const written = await tx.event.createMany({
          data: diffResult.events.map((e) => ({
            storeId,
            crawlId: null,
            entityType: e.entityType,
            entityKey: e.entityKey,
            eventType: e.eventType,
            oldValue: e.oldValue as never,
            newValue: e.newValue as never,
            significance: e.significance,
            headline: e.headline,
            backfilled: e.backfilled,
            dedupeKey: e.dedupeKey,
            detectedAt: now,
            occurredAt: e.occurredAt,
          })),
          skipDuplicates: true,
        });
        eventsWritten = written.count;
      }

      await tx.marketingCollectionRun.update({
        where: { id: runRow.id },
        data: {
          finishedAt: now,
          outcome: "SUCCESS",
          adsObserved: collected.ads.length,
          vendorRequestCount: collected.requestCount,
        },
      });

      if (isBaseline) {
        await tx.store.update({ where: { id: storeId }, data: { marketingBaselinedAt: now } });
      }
    },
    { timeout: 10_000, maxWait: 5_000 },
  );

  return {
    outcome: "SUCCESS",
    adsObserved: collected.ads.length,
    eventsWritten,
    vendorRequestCount: collected.requestCount,
  };
}
