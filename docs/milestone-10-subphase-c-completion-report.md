# Milestone 10 Sub-phase C Completion Report

## Status

PARTIAL

## Scope

Provider-neutral freemium entitlement and pricing alignment only. No crawler, intelligence, checkout, subscription, webhook, advertising, or provider SDK work was added.

## Product model implemented

FREE has unlimited individual-store analysis and one non-expiring monitored store. The future PAID model has unlimited analysis and up to 10 monitored stores at the same cadence.

## Previous entitlement model

FREE: three lifetime analyses, one 30-day monitor. BASIC: 20 monitors. BUSINESS: 50 monitors.

## New entitlement model

FREE: unlimited analyses, one monitor, no expiry. BASIC and BUSINESS are retained internal compatibility values and both receive the single PAID entitlement: 10 monitors and no expiry.

## FREE behavior

Analysis remains authenticated where it was authenticated, SSRF/rate/concurrency protections remain unchanged, and the analysis ledger is still recorded for analytics and per-user history.

## PAID behavior

The public label is Paid; billing is not available. Internal BASIC/BUSINESS rows are compatible with the 10-monitor future paid tier.

## Lifetime analysis cap removal

`maxUniqueAnalyses(FREE)` is now `null`; `recordAnalysisUsage()` continues recording but cannot reject on a lifetime count.

## Monitoring limit

Server-side `startMonitoring()` continues to hold a per-user advisory lock and count ACTIVE watches. FREE is limited to one; paid compatibility plans are limited to ten.

## Monitoring expiration removal

New watches have null expiry. A data-only migration nulls expiry for existing active watches. The legacy sweep remains safe but has no new finite watches to expire.

## Pricing page changes

Pricing now shows only Free and Paid, with an honest Coming soon state and no checkout.

## Unsupported pricing claims removed

Removed Pro/Business/Agency, faster-crawl, CSV/API export, alerts, seats, white-labeling, priority processing, and fake checkout messaging.

## Internal BASIC compatibility decision

No enum/schema rename was made. BASIC and BUSINESS are preserved to avoid destructive entitlement-data rewriting, but present as Paid publicly.

## Usage tracking decision

Preserved as useful analytics and ownership/history telemetry; only the obsolete commercial enforcement was neutralized.

## Billing-provider neutrality

No provider selected and no billing fields, models, SDKs, routes, payment links, or webhooks were added.

## Schema changes

None. One data-only migration clears expiry timestamps on active watches.

## Dependency changes

None.

## API changes

Watch API remains server-authoritative and returns the same structured entitlement denial.

## Security review

Authentication, session-derived plans/user IDs, ownership scoping, SSRF controls, rate limits, advisory locks, and scheduler authorization were not weakened.

## Test coverage

Unit tests cover the new limit table. Integration tests were updated for unlimited FREE analyses, one FREE monitor, non-expiry after 30 days, paid compatibility 10/11 boundary, and freeing a slot on removal.

## Unit test results

PASS: 350 tests.

## Integration test results

Not run before handoff.

## Typecheck

PASS.

## ESLint

Not run before handoff.

## Production build

Not run before handoff.

## Browser verification

Not run before handoff.

## Real Shopify verification

Not run before handoff; no new external crawl load was introduced.

## Bugs found

The old pricing UI advertised non-existent plans and capabilities; FREE enforcement was a lifetime three-store cap and a 30-day expiry.

## Bugs fixed

The cap, new-watch expiry, legacy active expiry data, stale public plans, and fake checkout messaging were addressed.

## Known limitations

The UI/report surface still needs full integration/browser validation after this partial handoff.

## Deferred work

Billing-provider selection, checkout, subscriptions, webhooks, ads, and any future paid capability expansion.

## Billing explicitly NOT implemented

No billing implementation exists in this change.

## Advertising explicitly NOT implemented

No advertising implementation exists in this change.

## STOP-condition evaluation

No stop condition was encountered: no security boundary, crawler behavior, provider coupling, or destructive schema rewrite was required.

## Files changed

Entitlement limits, monitoring/watch UI, pricing UI, dashboard copy, tests, a data-only migration, and this report.

## Final recommendation

MORE ENGINEERING REQUIRED — complete integration, lint/build, and browser/real-store verification before proceeding to billing integration.
