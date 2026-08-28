# Known future work

Standing list of changes that are **understood but not scheduled** — captured
so they aren't a surprise when something forces the issue. Not a backlog of
features; only things where a dependency, a deprecation, or an upstream
decision means the work is inevitable eventually.

---

## Prisma 5 → 6 → 7

**Current:** Prisma `5.22.x`. `multiSchema` is enabled as a preview feature
(`generator client { previewFeatures = ["multiSchema"] }`) — required on 5.x
for the `store_spy` / `control_plane` schema split.

### Prisma 6 — a one-line change

`multiSchema` graduated to GA in Prisma 6.0. Upgrading:

- Bump `prisma` and `@prisma/client` to `^6` together.
- **Delete the `previewFeatures = ["multiSchema"]` line** (it's the whole
  array). `schemas = [...]` on the datasource and every `@@schema(...)` on
  models/enums stay byte-identical — that syntax is unchanged, just GA.
  Leaving the preview line in only produces a warning, not an error.
- `prisma generate`, then `prisma migrate status` against a scratch database,
  then run the full migration chain on an empty database to confirm the
  schema-move migration still applies (it's plain SQL — it will).

Checked against this repo, none of Prisma 6.0's other breaking changes apply:
no `Bytes` fields (the `Buffer` → `Uint8Array` change), no `NOT:` in
production queries (the null-semantics change), and Node 20.9+ / TS 5.1+ /
PostgreSQL 10+ minimums are already met. The `search_path` `DATABASE_URL`
requirement is Postgres connection behavior, not preview-feature behavior, and
is unaffected.

### Prisma 7 — repo-wide import path change

Prisma 7 makes an explicit generator `output` path **mandatory** and moves the
generated client off the `prisma-client-js` generator onto `prisma-client`.
Consequence: the client no longer lives at `@prisma/client`, so every
`import { ... } from "@prisma/client"` across the codebase (and the
`node_modules/@prisma/client` re-export the singleton in `src/lib/db/prisma.ts`
relies on) changes to the generated path, e.g.
`import { PrismaClient } from "@/generated/prisma/client"`.

This is a mechanical but repo-wide edit (dozens of files) plus a generator
config change and a `.gitignore` entry for the output directory. Prisma 6.x
already emits a deprecation warning nudging toward this. Do it deliberately as
its own change — not bundled with the 5 → 6 version bump.

**Not scheduled.** No forced-upgrade pressure yet; 5.22 is stable and
multiSchema-as-preview has been production-used for years. Revisit when a
Prisma feature or fix we need lands 6.x-only.
