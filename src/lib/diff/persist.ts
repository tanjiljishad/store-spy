import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  computeCatalogHash,
  computeRankHash,
  computeTechHash,
} from "../crawl/normalize";
import type {
  NormalizedStoreSnapshot,
  PreviousEntityState,
  PreviousProductState,
  StoreContext,
} from "../crawl/types";
import { diffStore, type DiffResult } from "./engine";
import { nextCrawlAfterSuccess } from "../monitoring/policy";

const ABORTED_RETRY_DELAY_MS = 60 * 60 * 1000; // 1h — same order as the first failure-backoff step

/**
 * Orchestrates one crawl→diff→persist cycle.
 *
 * Ordering matters and is not arbitrary:
 *   1. hash short-circuit  — ~95% of crawls exit here having written one row
 *   2. load previous state — a single indexed query, never N+1
 *   3. pure diff           — no IO
 *   4. one transaction     — events and state move together or not at all,
 *      and every write inside it is a single bulk statement — never one
 *      round trip per product. At 250 products/store and ~5ms network RTT
 *      to a remote Postgres, a per-row loop turns into >1s of held locks;
 *      bulk statements turn the whole transaction into single-digit ms.
 */

export interface RunDiffArgs {
  prisma: PrismaClient;
  storeId: string;
  crawlId: string;
  snapshot: NormalizedStoreSnapshot;
  now?: Date;
}

export interface RunDiffOutcome {
  shortCircuited: boolean;
  result: DiffResult | null;
  eventsWritten: number;
}

export async function runDiffAndPersist(args: RunDiffArgs): Promise<RunDiffOutcome> {
  const { prisma, storeId, crawlId, snapshot } = args;
  const now = args.now ?? new Date();

  const catalogHash = computeCatalogHash(snapshot);
  const rankHash = computeRankHash(snapshot);
  const techHash = computeTechHash(snapshot);

  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    include: { stats: true },
  });

  // Computed once, reused by every success path below (short-circuit and
  // full diff both advance the schedule the same way). null means DISABLED —
  // omit the field rather than write null into a NOT NULL column.
  const nextCrawlAt = nextCrawlAfterSuccess(store.tier, now);

  const lastCrawl = await prisma.crawl.findFirst({
    where: { storeId, status: { in: ["OK", "PARTIAL"] }, id: { not: crawlId } },
    orderBy: { startedAt: "desc" },
    select: { catalogHash: true, rankHash: true, techHash: true },
  });

  // -------------------------------------------------------------------------
  // SHORT-CIRCUIT
  //
  // Nothing changed in the catalog, the ranking, or the tech stack. Record the
  // crawl, bump the unchanged streak, and stop. This is what keeps storage at
  // gigabytes instead of terabytes, and it is why rankHash is kept separate
  // from catalogHash — ranks churn daily and would defeat this on every store.
  // -------------------------------------------------------------------------
  const unchanged =
    lastCrawl !== null &&
    lastCrawl.catalogHash === catalogHash &&
    lastCrawl.rankHash === rankHash &&
    lastCrawl.techHash === techHash &&
    store.baselinedAt !== null;

  if (unchanged) {
    await prisma.$transaction([
      prisma.crawl.update({
        where: { id: crawlId },
        data: {
          status: snapshot.partial ? "PARTIAL" : "OK",
          finishedAt: now,
          catalogHash,
          rankHash,
          techHash,
          productCount: snapshot.products.length,
          pagesExpected: snapshot.pagesExpected,
          pagesFetched: snapshot.pagesFetched,
          httpErrors: snapshot.httpErrors,
        },
      }),
      prisma.store.update({
        where: { id: storeId },
        data: {
          lastCrawledAt: now,
          unchangedStreak: { increment: 1 },
          failureStreak: 0,
          ...(nextCrawlAt ? { nextCrawlAt } : {}),
        },
      }),
    ]);

    return { shortCircuited: true, result: null, eventsWritten: 0 };
  }

  // -------------------------------------------------------------------------
  // LOAD PREVIOUS STATE — two indexed queries, run concurrently, never N+1
  // -------------------------------------------------------------------------
  const [previousRows, previousEntityRows] = await Promise.all([
    prisma.product.findMany({
      where: { storeId },
      select: {
        id: true,
        externalId: true,
        handle: true,
        title: true,
        status: true,
        priceMinCents: true,
        priceMaxCents: true,
        compareAtMaxCents: true,
        variantCount: true,
        availableVariants: true,
        bestsellerRank: true,
        missingStreak: true,
        missingSince: true,
        firstSeenAt: true,
      },
    }),
    prisma.storeEntity.findMany({
      where: { storeId },
      select: {
        id: true,
        kind: true,
        key: true,
        meta: true,
        status: true,
        missingStreak: true,
        missingSince: true,
        firstSeenAt: true,
      },
    }),
  ]);

  const previous = previousRows as unknown as PreviousProductState[];
  const previousEntities = previousEntityRows as unknown as PreviousEntityState[];

  const context: StoreContext = {
    id: store.id,
    domain: store.domain,
    currency: store.currency ?? snapshot.currency ?? "USD",
    baselinedAt: store.baselinedAt,
    themeName: store.themeName,
    themeVersion: store.themeVersion,
    entities: previousEntities,
    stats: store.stats
      ? {
          priceChangesInWindow: store.stats.priceChangesInWindow,
          productsAddedInWindow: store.stats.productsAddedInWindow,
          crawlsInWindow: store.stats.crawlsInWindow,
          productCount: store.stats.productCount,
          medianPriceCents: store.stats.medianPriceCents,
        }
      : null,
  };

  // -------------------------------------------------------------------------
  // PURE DIFF
  // -------------------------------------------------------------------------
  const result = diffStore({ store: context, previous, snapshot, now });

  if (result.aborted) {
    await prisma.$transaction([
      prisma.crawl.update({
        where: { id: crawlId },
        data: {
          status: "FAILED",
          finishedAt: now,
          errorMessage: result.abortReason,
          productCount: snapshot.products.length,
        },
      }),
      // Deliberately do NOT bump failureStreak or touch tier here — the
      // crawl fetched fine, the data was untrustworthy. Those need different
      // alerting. It still deserves a prompt retry rather than waiting out a
      // full cadence cycle, so nextCrawlAt moves up — but on a short fixed
      // delay, not the failure-backoff curve.
      prisma.store.update({
        where: { id: storeId },
        data: { nextCrawlAt: new Date(now.getTime() + ABORTED_RETRY_DELAY_MS) },
      }),
    ]);
    return { shortCircuited: false, result, eventsWritten: 0 };
  }

  // -------------------------------------------------------------------------
  // PERSIST — one transaction. Partial writes would corrupt the event stream,
  // and a corrupted append-only log cannot be repaired after the fact.
  // -------------------------------------------------------------------------
  let eventsWritten = 0;

  await prisma.$transaction(
    async (tx) => {
      // -----------------------------------------------------------------
      // PRODUCTS — one bulk upsert instead of up to `upserts.length`
      // sequential round trips. We pre-assign every row's id client-side
      // (reusing the existing id for known products) so the snapshot
      // insert below never has to read anything back from this statement.
      // -----------------------------------------------------------------
      if (result.upserts.length > 0) {
        const productIds = result.upserts.map((u) => u.productId ?? randomUUID());

        const rows = result.upserts.map((u, i) => ({
          id: productIds[i],
          externalId: u.externalId,
          handle: u.handle,
          title: u.title,
          vendor: u.vendor,
          productType: u.productType,
          tags: u.tags,
          sourceCreatedAt: u.sourceCreatedAt,
          status: u.status,
          missingStreak: u.missingStreak,
          missingSince: u.missingSince,
          priceMinCents: u.priceMinCents,
          priceMaxCents: u.priceMaxCents,
          compareAtMaxCents: u.compareAtMaxCents,
          variantCount: u.variantCount,
          availableVariants: u.availableVariants,
          bestsellerRank: u.bestsellerRank,
          imageHash: u.imageHash,
          lastSeenAt: u.lastSeenAt,
        }));

        await tx.$executeRaw`
          INSERT INTO "Product" (
            id, "storeId", "externalId", handle, title, vendor, "productType", tags,
            "sourceCreatedAt", status, "firstSeenAt", "lastSeenAt", "missingSince", "missingStreak",
            "priceMinCents", "priceMaxCents", "compareAtMaxCents", "variantCount",
            "availableVariants", "bestsellerRank", "imageHash"
          )
          -- "AT TIME ZONE 'UTC'" on every timestamptz->timestamp(3) value below is
          -- load-bearing, not decorative: jsonb_to_recordset types these columns
          -- timestamptz, but the target columns are timestamp(3) (no tz). Without
          -- the explicit cast, Postgres converts through the *session's* TimeZone
          -- GUC on assignment — correct only by accident when that GUC happens to
          -- be UTC. Prisma's typed client sidesteps this (it round-trips Date
          -- consistently regardless of session TZ); raw SQL does not.
          SELECT
            x.id, ${storeId}, x."externalId", x.handle, x.title, x.vendor, x."productType", x.tags,
            (x."sourceCreatedAt" AT TIME ZONE 'UTC'), x.status::"ProductStatus", (${now}::timestamptz AT TIME ZONE 'UTC'),
            COALESCE((x."lastSeenAt" AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC')), (x."missingSince" AT TIME ZONE 'UTC'), x."missingStreak",
            x."priceMinCents", x."priceMaxCents", x."compareAtMaxCents", x."variantCount",
            x."availableVariants", x."bestsellerRank", x."imageHash"
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
            id text, "externalId" text, handle text, title text, vendor text, "productType" text,
            tags text[], "sourceCreatedAt" timestamptz, status text, "missingStreak" int,
            "missingSince" timestamptz, "priceMinCents" int, "priceMaxCents" int,
            "compareAtMaxCents" int, "variantCount" int, "availableVariants" int,
            "bestsellerRank" int, "imageHash" text, "lastSeenAt" timestamptz
          )
          ON CONFLICT ("storeId", "externalId") DO UPDATE SET
            handle = EXCLUDED.handle,
            title = EXCLUDED.title,
            vendor = EXCLUDED.vendor,
            "productType" = EXCLUDED."productType",
            tags = EXCLUDED.tags,
            "sourceCreatedAt" = EXCLUDED."sourceCreatedAt",
            status = EXCLUDED.status,
            "missingStreak" = EXCLUDED."missingStreak",
            "missingSince" = EXCLUDED."missingSince",
            "priceMinCents" = EXCLUDED."priceMinCents",
            "priceMaxCents" = EXCLUDED."priceMaxCents",
            "compareAtMaxCents" = EXCLUDED."compareAtMaxCents",
            "variantCount" = EXCLUDED."variantCount",
            "availableVariants" = EXCLUDED."availableVariants",
            "bestsellerRank" = EXCLUDED."bestsellerRank",
            "imageHash" = EXCLUDED."imageHash",
            -- lastSeenAt only advances when the product was actually seen this
            -- crawl. The removal path sends lastSeenAt: null (see engine.ts),
            -- but NULL can't survive to here — Postgres enforces NOT NULL on the
            -- candidate tuple before ON CONFLICT resolution runs, so the SELECT
            -- above already substitutes ${now} for it. status is therefore the
            -- only signal left to tell "genuinely active" from "missing/removed".
            "lastSeenAt" = CASE WHEN EXCLUDED.status = 'ACTIVE'
                                THEN EXCLUDED."lastSeenAt"
                                ELSE "Product"."lastSeenAt" END
        `;

        // History rows ONLY on change. This is the 95% storage saving —
        // still a single statement, just a plain bulk insert (no conflict
        // target, so Prisma's own createMany covers it).
        const snapshotRows = result.upserts.flatMap((u, i) =>
          u.stateChanged
            ? [
                {
                  productId: productIds[i],
                  crawlId,
                  capturedAt: now,
                  priceMinCents: u.priceMinCents,
                  priceMaxCents: u.priceMaxCents,
                  compareAtMaxCents: u.compareAtMaxCents,
                  variantCount: u.variantCount,
                  availableVariants: u.availableVariants,
                  bestsellerRank: u.bestsellerRank,
                },
              ]
            : [],
        );

        if (snapshotRows.length > 0) {
          await tx.productStateSnapshot.createMany({ data: snapshotRows });
        }
      }

      // -----------------------------------------------------------------
      // STORE ENTITIES — apps, pixels, collections, payment providers.
      // Same bulk-upsert shape as Product, same lastSeenAt protection. meta
      // gets the identical treatment: only overwritten on a genuine ACTIVE
      // observation, so a pixel ID isn't wiped out the moment it goes
      // MISSING — the last known value stays visible while it's flapping.
      // -----------------------------------------------------------------
      if (result.entityUpserts.length > 0) {
        const entityIds = result.entityUpserts.map((u) => u.entityId ?? randomUUID());

        const entityRows = result.entityUpserts.map((u, i) => ({
          id: entityIds[i],
          kind: u.kind,
          key: u.key,
          meta: u.meta,
          status: u.status,
          missingStreak: u.missingStreak,
          missingSince: u.missingSince,
          lastSeenAt: u.lastSeenAt,
        }));

        await tx.$executeRaw`
          INSERT INTO "StoreEntity" (
            id, "storeId", kind, key, meta, status, "firstSeenAt", "lastSeenAt", "missingSince", "missingStreak"
          )
          -- See the matching comment on the Product upsert above: these
          -- AT TIME ZONE 'UTC' casts are the fix for a real bug, not style.
          SELECT
            x.id, ${storeId}, x.kind::"StoreEntityKind", x.key, x.meta, x.status::"ProductStatus",
            (${now}::timestamptz AT TIME ZONE 'UTC'), COALESCE((x."lastSeenAt" AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC')), (x."missingSince" AT TIME ZONE 'UTC'), x."missingStreak"
          FROM jsonb_to_recordset(${JSON.stringify(entityRows)}::jsonb) AS x(
            id text, kind text, key text, meta jsonb, status text,
            "missingStreak" int, "missingSince" timestamptz, "lastSeenAt" timestamptz
          )
          ON CONFLICT ("storeId", kind, key) DO UPDATE SET
            meta = CASE WHEN EXCLUDED.status = 'ACTIVE' THEN EXCLUDED.meta ELSE "StoreEntity".meta END,
            status = EXCLUDED.status,
            "missingStreak" = EXCLUDED."missingStreak",
            "missingSince" = EXCLUDED."missingSince",
            "lastSeenAt" = CASE WHEN EXCLUDED.status = 'ACTIVE'
                                THEN EXCLUDED."lastSeenAt"
                                ELSE "StoreEntity"."lastSeenAt" END
        `;
      }

      if (result.events.length > 0) {
        const written = await tx.event.createMany({
          data: result.events.map((e) => ({
            storeId,
            crawlId,
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
          skipDuplicates: true, // idempotency: retrying a crawl is a no-op
        });
        eventsWritten = written.count;
      }

      await tx.crawl.update({
        where: { id: crawlId },
        data: {
          status: snapshot.partial ? "PARTIAL" : "OK",
          finishedAt: now,
          catalogHash,
          rankHash,
          techHash,
          productCount: snapshot.products.length,
          pagesExpected: snapshot.pagesExpected,
          pagesFetched: snapshot.pagesFetched,
          httpErrors: snapshot.httpErrors,
        },
      });

      await tx.store.update({
        where: { id: storeId },
        data: {
          lastCrawledAt: now,
          lastChangedAt: result.catalogChanged ? now : undefined,
          unchangedStreak: result.catalogChanged ? 0 : { increment: 1 },
          failureStreak: 0,
          baselinedAt: store.baselinedAt ?? now,
          ...(nextCrawlAt ? { nextCrawlAt } : {}),
          ...(result.storePatch.themeName !== undefined
            ? { themeName: result.storePatch.themeName }
            : {}),
          ...(result.storePatch.themeVersion !== undefined
            ? { themeVersion: result.storePatch.themeVersion }
            : {}),
        },
      });
    },
    // Three-to-five bulk statements, not one round trip per product — closes
    // in milliseconds for a typical few-hundred-product store. But at the
    // large end of what this app actually crawls (fashionnova.com: 15,000
    // products, 3,000 store entities, thousands of new-product events in one
    // first crawl) a 10s budget isn't headroom, it's the wall: P2028
    // "Transaction already closed" fired at 10,030ms in live testing, which
    // surfaces to the user as a failed analysis even though every write
    // would have succeeded given a few more seconds. 60s comfortably covers
    // the largest stores seen so far without holding locks indefinitely on a
    // genuinely stuck transaction.
    { timeout: 60_000, maxWait: 5_000 },
  );

  return { shortCircuited: false, result, eventsWritten };
}
