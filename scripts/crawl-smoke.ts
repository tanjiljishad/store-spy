/**
 * Live smoke test: crawls a real Shopify store, normalizes it, and runs it
 * through diffStore() twice — once as a baseline, once again a few seconds
 * later against the first crawl's product state — to prove the full
 * crawl -> normalize -> diff pipeline works against a real storefront, not
 * just hand-built fixtures. The second pass is also a real false-positive
 * check: an essentially-unchanged store should produce ~zero alertable events.
 */
import { crawlShopifyStore } from "../src/lib/crawl/shopify";
import { normalizeSnapshot } from "../src/lib/crawl/normalize";
import { diffStore } from "../src/lib/diff/engine";
import type { PreviousEntityState, PreviousProductState, StoreContext } from "../src/lib/crawl/types";

const domain = process.argv[2] ?? "allbirds.com";

function store(overrides: Partial<StoreContext> = {}): StoreContext {
  return {
    id: "smoke_store",
    domain,
    currency: "USD",
    baselinedAt: null,
    themeName: null,
    themeVersion: null,
    entities: [],
    stats: null,
    ...overrides,
  };
}

async function crawlOnce(label: string) {
  console.log(`\n=== ${label}: crawling ${domain} ===`);
  const result = await crawlShopifyStore(domain);

  if (result.status !== "ok") {
    console.log(`status: ${result.status}`);
    console.log(`reason: ${result.reason}`);
    return null;
  }

  const snapshot = normalizeSnapshot(result.input);
  console.log(`status: ok`);
  console.log(`products: ${snapshot.products.length}`);
  console.log(`partial: ${snapshot.partial}  httpErrors: ${result.input.httpErrors}  pagesFetched: ${result.input.pagesFetched}`);
  console.log(`hasRankData: ${snapshot.hasRankData}  hasCollectionData: ${snapshot.hasCollectionData}  hasTechData: ${snapshot.hasTechData}`);
  console.log(`collections: ${snapshot.collectionHandles.length} (${snapshot.collectionHandles.slice(0, 5).join(", ")}${snapshot.collectionHandles.length > 5 ? ", ..." : ""})`);
  console.log(`currency: ${snapshot.currency}`);
  if (snapshot.tech) {
    console.log(`theme: ${snapshot.tech.themeName ?? "(not detected)"} ${snapshot.tech.themeVersion ?? ""}`);
    console.log(`apps: ${snapshot.tech.apps.join(", ") || "(none detected)"}`);
    console.log(`pixels: ${JSON.stringify(snapshot.tech.pixels)}`);
    console.log(`paymentProviders: ${snapshot.tech.paymentProviders.join(", ") || "(none detected)"}`);
    console.log(`emailPlatform: ${snapshot.tech.emailPlatform ?? "(not detected)"}`);
  } else {
    console.log(`tech: (homepage fetch failed)`);
  }

  return snapshot;
}

async function main() {
  const first = await crawlOnce("Crawl 1");
  if (!first) return;

  const now1 = new Date();
  const baseline = diffStore({ store: store({ baselinedAt: null }), previous: [], snapshot: first, now: now1 });
  console.log(`\n--- baseline diff ---`);
  console.log(`isBaseline: ${baseline.isBaseline}`);
  console.log(`alertable events: ${baseline.events.filter((e) => !e.backfilled).length} (should be 0)`);
  console.log(`backfilled events: ${baseline.events.filter((e) => e.backfilled).length}`);

  const previous: PreviousProductState[] = baseline.upserts.map((u) => ({
    id: `row_${u.externalId}`,
    externalId: u.externalId,
    handle: u.handle,
    title: u.title,
    status: u.status,
    priceMinCents: u.priceMinCents,
    priceMaxCents: u.priceMaxCents,
    compareAtMaxCents: u.compareAtMaxCents,
    variantCount: u.variantCount,
    availableVariants: u.availableVariants,
    bestsellerRank: u.bestsellerRank,
    missingStreak: u.missingStreak,
    missingSince: u.missingSince,
    firstSeenAt: now1,
  }));

  // Carries baseline.entityUpserts forward exactly like persist.ts would —
  // this is the piece that was missing before: without it, every crawl
  // diffs against an empty entity set and every app/pixel/collection fires
  // as newly added, forever.
  const previousEntities: PreviousEntityState[] = baseline.entityUpserts.map((u, i) => ({
    id: u.entityId ?? `entity_${i}`,
    kind: u.kind,
    key: u.key,
    meta: u.meta,
    status: u.status,
    missingStreak: u.missingStreak,
    missingSince: u.missingSince,
    firstSeenAt: now1,
  }));
  console.log(`entities persisted from baseline: ${previousEntities.length}`);

  console.log("\nWaiting 15s before the second crawl...");
  await new Promise((r) => setTimeout(r, 15_000));

  const second = await crawlOnce("Crawl 2");
  if (!second) return;

  const now2 = new Date();
  const storeAfterBaseline = store({ baselinedAt: now1, entities: previousEntities });
  const followUp = diffStore({ store: storeAfterBaseline, previous, snapshot: second, now: now2 });

  console.log(`\n--- follow-up diff (real store, ~15s later) ---`);
  console.log(`aborted: ${followUp.aborted}${followUp.abortReason ? ` (${followUp.abortReason})` : ""}`);
  console.log(`total events: ${followUp.events.length}`);
  for (const e of followUp.events.slice(0, 20)) {
    console.log(`  [${e.significance}] ${e.eventType} — ${e.headline}`);
  }
  if (followUp.events.length > 20) console.log(`  ... and ${followUp.events.length - 20} more`);
  console.log(`suppressedCount: ${followUp.suppressedCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
