<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Database time rule

All application timestamps must be treated as UTC.

- Prisma typed Date operations (`.create()`, `.update()`, typed `where` filters, etc.) already round-trip `Date` correctly regardless of the Postgres session's `TimeZone` — preserve that behavior, don't work around it.
- Raw SQL (`$queryRaw`/`$executeRaw`) with Date parameters compared against or written into a `TIMESTAMP` (no tz) column does **not** get the same treatment: Postgres implicitly casts through the session's `TimeZone` GUC, not UTC. Every such site must explicitly cast, e.g. `(${now}::timestamptz AT TIME ZONE 'UTC')` — see `src/lib/diff/persist.ts` and `src/lib/monitoring/scheduler.ts` for the pattern.
- Never assume the database session timezone is UTC. It was `Asia/Dhaka` in this project's own embedded test Postgres (inherited from host OS), which silently shifted `Store.nextCrawlAt` comparisons and `Product.firstSeenAt`/`lastSeenAt` writes by 6 hours — undetected until a live integration run caught it.
- When introducing a new raw SQL query that touches a timestamp, add a regression test that pins a non-UTC session timezone explicitly (e.g. a dedicated `PrismaClient` with `connection_limit=1`, then `SET TIME ZONE` to something pathological before exercising the query) — a test that only happens to pass because the CI/dev machine's Postgres defaults to UTC proves nothing.
