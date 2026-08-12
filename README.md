# Diff Engine — Ecommerce Intelligence Engine

The change-detection core. Turns two catalog snapshots into a scored, deduplicated event stream.

```
crawl → normalize → hash → [short-circuit?] → diffStore() → persist (1 txn)
                                                    ↑
                                              pure, no IO
```

## Files

| File | Role |
|---|---|
| `prisma/schema.prisma` | Data model. `Event` is append-only and immutable |
| `src/lib/money.ts` | Integer-cents parsing, canonical JSON, hashing |
| `src/lib/crawl/types.ts` | Crawler↔engine contract. Swap platforms here, not in the engine |
| `src/lib/crawl/normalize.ts` | Shopify JSON → `NormalizedStoreSnapshot`, dual hashing |
| `src/lib/diff/events.ts` | Event types, dedupe keys, `DiffConfig` |
| `src/lib/diff/significance.ts` | `base × magnitude × relevance × rarity × crossStore` |
| `src/lib/diff/engine.ts` | `diffStore()` — pure, deterministic |
| `src/lib/diff/persist.ts` | Prisma writes, one transaction |

## Setup

```bash
npm i
npx prisma generate && npx prisma migrate dev --name init
npm test
```

`persist.ts` won't typecheck until `prisma generate` has run.

## Integration tests

`npm test` is pure `engine.ts`, no DB, safe to run on every save. `persist.ts`'s
DB path — bulk upsert SQL, idempotency, the short-circuit row counts — needs a
real Postgres and lives in a separate suite:

```bash
npm run db:test:up
npm run db:test:migrate
npm run test:integration
```

All three go through `.env.test` (copy `.env.test.example`), loaded via
`dotenv-cli` — never export `DATABASE_URL`/`TEST_DATABASE_URL` in your shell
for this. `persist.integration.test.ts` truncates every table in `beforeEach`
and refuses to run unless `DATABASE_URL` is set and contains `test`, so a
shell with the wrong variable exported can't point it at a real database.

## Integration

```ts
const snapshot = normalizeSnapshot({ domain, rawProducts, bestsellerRanks, ... });
const { shortCircuited, result, eventsWritten } = await runDiffAndPersist({
  prisma, storeId, crawlId, snapshot,
});
```

Two hydration points are stubbed in `persist.ts` — `knownApps` and `knownCollections` on
`StoreContext`. Wire these to your tech/collection tables or those event types stay silent.

## The four guards

Ordinary diffing is ten lines. Everything below exists because naive diffing ships false
positives to paying customers, and a user who gets one wrong "247 products discontinued"
alert never trusts the product again.

1. **Shrink circuit breaker** — catalog down >40% → abort the whole diff, mark the crawl
   failed. A silent pagination failure must never read as mass discontinuation.
2. **Partial-crawl suppression** — `snapshot.partial` → additions and price changes still
   process, removals are skipped entirely and missing-streaks are left untouched.
3. **Removal state machine** — `ACTIVE → MISSING(1) → MISSING(2) → REMOVED`. Absence must
   be confirmed across N consecutive clean crawls.
4. **Bulk-operation cap** — past `maxEventsPerCrawl`, keep the top events by significance
   and return the rest as `suppressedCount` for the digest to summarise.

Plus the **baseline guard**: on a store's first crawl, no alertable events fire. History is
reconstructed retroactively from each product's `created_at` and flagged `backfilled: true` —
those rows power charts and are excluded from alerts.

## Storage economics

Naive snapshotting of 100k stores × 250 products is roughly 9TB/year, ~97% of it duplicate rows.

- `catalogHash` short-circuits ~95% of crawls to a single `Crawl` row.
- `rankHash` is kept **separate** — bestseller order churns daily and folding it into
  `catalogHash` would defeat the short-circuit on every store, every day.
- `ProductStateSnapshot` rows are written only when state actually changed.

## Tuning

`DEFAULT_DIFF_CONFIG` in `events.ts` and `BASE_SCORE` / `SATURATION_K` in `significance.ts`
are calibrated starting points, not truths. Recalibrate against real data after a few weeks.

The thing to watch: `SATURATION_K`. Significance uses exponential saturation rather than a
hard clamp because clamping destroys ordering at the top of the scale — a big drop on a
bestseller pins to 100 before the cross-store multiplier applies, making your strongest
signal invisible exactly when it matters. If most events cluster near 95+, raise K.

## Idempotency

Every event carries a `dedupeKey` derived from `(storeId, entityKey, eventType, discriminator)`.
The unique index plus `skipDuplicates` makes crawl retries no-ops. Noisy types (sell-outs,
rank moves) use a day bucket as discriminator so a flapping value can't emit twice daily.

## Next

- `crossStoreCounts` is wired through but always empty — populate it from a weekly aggregate
  over `events` grouped by `imageHash`. That's the term competitors can't replicate.
- Digest renderer reading `(storeId, significance DESC, occurredAt DESC)`.
- `StoreStats` recompute job; the rarity term is inert until `crawlsInWindow >= 5`.
