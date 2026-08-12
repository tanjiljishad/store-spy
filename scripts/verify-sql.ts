/**
 * Verifies the bulk-upsert SQL against a real Postgres, without Prisma.
 * The DDL below mirrors the generated schema for the columns the SQL touches.
 *
 * DROPs tables — run only via `npm run verify:sql`, which loads .env.test
 * through dotenv-cli. Never point this at a real DATABASE_URL.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url || !/test/i.test(url)) {
  throw new Error(`Refusing to run: this script DROPs tables. DATABASE_URL=${url}`);
}

const client = new pg.Client({ connectionString: url });

const DDL = `
DROP TABLE IF EXISTS "ProductStateSnapshot", "Product", "Store" CASCADE;
DROP TYPE IF EXISTS "ProductStatus";
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE','MISSING','REMOVED');

CREATE TABLE "Store" (
  id TEXT PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL
);

CREATE TABLE "Product" (
  id TEXT PRIMARY KEY,
  "storeId" TEXT NOT NULL REFERENCES "Store"(id) ON DELETE CASCADE,
  "externalId" TEXT NOT NULL,
  handle TEXT NOT NULL,
  title TEXT NOT NULL,
  vendor TEXT,
  "productType" TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  "sourceCreatedAt" TIMESTAMPTZ,
  status "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
  "firstSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "missingSince" TIMESTAMPTZ,
  "missingStreak" INT NOT NULL DEFAULT 0,
  "priceMinCents" INT NOT NULL,
  "priceMaxCents" INT NOT NULL,
  "compareAtMaxCents" INT,
  "variantCount" INT NOT NULL DEFAULT 0,
  "availableVariants" INT NOT NULL DEFAULT 0,
  "bestsellerRank" INT,
  "imageHash" VARCHAR(32),
  UNIQUE ("storeId","externalId")
);

CREATE TABLE "ProductStateSnapshot" (
  id TEXT PRIMARY KEY,
  "productId" TEXT NOT NULL REFERENCES "Product"(id) ON DELETE CASCADE,
  "capturedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "priceMinCents" INT NOT NULL
);
`;

/** The statement under test — same shape as persist.ts. */
const BULK_UPSERT = `
INSERT INTO "Product" (
  id, "storeId", "externalId", handle, title, vendor, "productType", tags,
  "sourceCreatedAt", status, "missingStreak", "missingSince",
  "priceMinCents", "priceMaxCents", "compareAtMaxCents",
  "variantCount", "availableVariants", "bestsellerRank", "imageHash",
  "firstSeenAt", "lastSeenAt"
)
SELECT
  r.id, $2, r."externalId", r.handle, r.title, r.vendor, r."productType", r.tags,
  r."sourceCreatedAt", r.status::"ProductStatus", r."missingStreak", r."missingSince",
  r."priceMinCents", r."priceMaxCents", r."compareAtMaxCents",
  r."variantCount", r."availableVariants", r."bestsellerRank", r."imageHash",
  $3::timestamptz, COALESCE(r."lastSeenAt", $3::timestamptz)
FROM jsonb_to_recordset($1::jsonb) AS r(
  id text, "externalId" text, handle text, title text, vendor text,
  "productType" text, tags text[], "sourceCreatedAt" timestamptz,
  status text, "missingStreak" int, "missingSince" timestamptz,
  "priceMinCents" int, "priceMaxCents" int, "compareAtMaxCents" int,
  "variantCount" int, "availableVariants" int, "bestsellerRank" int,
  "imageHash" text, "lastSeenAt" timestamptz
)
ON CONFLICT ("storeId","externalId") DO UPDATE SET
  handle = EXCLUDED.handle,
  title = EXCLUDED.title,
  tags = EXCLUDED.tags,
  status = EXCLUDED.status,
  "missingStreak" = EXCLUDED."missingStreak",
  "missingSince" = EXCLUDED."missingSince",
  "priceMinCents" = EXCLUDED."priceMinCents",
  "priceMaxCents" = EXCLUDED."priceMaxCents",
  "compareAtMaxCents" = EXCLUDED."compareAtMaxCents",
  "variantCount" = EXCLUDED."variantCount",
  "availableVariants" = EXCLUDED."availableVariants",
  "bestsellerRank" = EXCLUDED."bestsellerRank",
  -- lastSeenAt means "last crawl in which we actually saw this product", so it
  -- may only advance when the product was seen. The removal path writes status
  -- MISSING/REMOVED and must leave it frozen at the true last sighting.
  -- NOTE: NULL cannot be used as the signal here — Postgres enforces NOT NULL on
  -- the candidate tuple BEFORE ON CONFLICT resolution, so a NULL never reaches
  -- EXCLUDED. status is the correct semantic discriminator anyway.
  "lastSeenAt" = CASE WHEN EXCLUDED.status = 'ACTIVE'
                      THEN EXCLUDED."lastSeenAt"
                      ELSE "Product"."lastSeenAt" END
`;

const NOW = new Date("2026-08-08T12:00:00Z");
const LATER = new Date("2026-08-09T12:00:00Z");

function row(o: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    externalId: "p1",
    handle: "widget",
    title: "Widget",
    vendor: "Acme",
    productType: "Gadget",
    tags: ["sale", "new"],
    sourceCreatedAt: null,
    status: "ACTIVE",
    missingStreak: 0,
    missingSince: null,
    priceMinCents: 7900,
    priceMaxCents: 7900,
    compareAtMaxCents: null,
    variantCount: 3,
    availableVariants: 3,
    bestsellerRank: 2,
    imageHash: null,
    lastSeenAt: NOW.toISOString(),
    ...o,
  };
}

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = "") {
  results.push([name, pass, detail]);
}

async function main() {
  await client.connect();
  await client.query(DDL);
  await client.query(`INSERT INTO "Store"(id,domain) VALUES ('s1','example.com')`);

  // --- 1. insert path + tags text[] cast ------------------------------------
  const r1 = await client.query(BULK_UPSERT, [
    JSON.stringify([row(), row({ externalId: "p2", title: "Gizmo", tags: [] })]),
    "s1",
    NOW.toISOString(),
  ]);
  check("bulk insert affects all rows", r1.rowCount === 2, `rowCount=${r1.rowCount}`);

  const tags = await client.query(
    `SELECT tags, pg_typeof(tags)::text AS t FROM "Product" WHERE "externalId"='p1'`,
  );
  check(
    "jsonb array -> text[] cast works",
    tags.rows[0].t === "text[]" && tags.rows[0].tags.join(",") === "sale,new",
    `type=${tags.rows[0].t} value=${JSON.stringify(tags.rows[0].tags)}`,
  );

  const empty = await client.query(`SELECT tags FROM "Product" WHERE "externalId"='p2'`);
  check("empty json array -> empty text[]", empty.rows[0].tags.length === 0);

  // --- 2. update path -------------------------------------------------------
  const idsBefore = await client.query(`SELECT id FROM "Product" WHERE "externalId"='p1'`);
  const r2 = await client.query(BULK_UPSERT, [
    JSON.stringify([row({ id: randomUUID(), priceMinCents: 5900, lastSeenAt: LATER.toISOString() })]),
    "s1",
    LATER.toISOString(),
  ]);
  const after = await client.query(
    `SELECT id, "priceMinCents", "lastSeenAt", "firstSeenAt" FROM "Product" WHERE "externalId"='p1'`,
  );
  check("conflict updates rather than duplicates", r2.rowCount === 1 && after.rows.length === 1);
  check("price updated", after.rows[0].priceMinCents === 5900);
  check(
    "id is NOT overwritten on conflict (FK stability)",
    after.rows[0].id === idsBefore.rows[0].id,
    "a changed id here would orphan every snapshot row",
  );
  check(
    "firstSeenAt preserved on update",
    new Date(after.rows[0].firstSeenAt).toISOString() === NOW.toISOString(),
  );
  check(
    "lastSeenAt advanced",
    new Date(after.rows[0].lastSeenAt).toISOString() === LATER.toISOString(),
  );

  // --- 3. removal path: lastSeenAt must NOT move ----------------------------
  await client.query(BULK_UPSERT, [
    JSON.stringify([
      row({
        id: randomUUID(),
        status: "MISSING",
        missingStreak: 1,
        missingSince: LATER.toISOString(),
        lastSeenAt: null, // the "don't touch" signal
      }),
    ]),
    "s1",
    new Date("2026-08-10T12:00:00Z").toISOString(),
  ]);
  const removed = await client.query(
    `SELECT status, "missingStreak", "lastSeenAt" FROM "Product" WHERE "externalId"='p1'`,
  );
  check(
    "lastSeenAt frozen on non-ACTIVE status (removal path)",
    new Date(removed.rows[0].lastSeenAt).toISOString() === LATER.toISOString(),
    `got ${new Date(removed.rows[0].lastSeenAt).toISOString()}`,
  );
  check("status transitioned to MISSING", removed.rows[0].status === "MISSING");

  // --- 4. pre-assigned ids are usable for snapshots in the same txn ---------
  await client.query("BEGIN");
  const newId = randomUUID();
  await client.query(BULK_UPSERT, [
    JSON.stringify([row({ id: newId, externalId: "p3", title: "Doohickey" })]),
    "s1",
    NOW.toISOString(),
  ]);
  await client.query(
    `INSERT INTO "ProductStateSnapshot"(id,"productId","priceMinCents") VALUES ($1,$2,$3)`,
    [randomUUID(), newId, 7900],
  );
  await client.query("COMMIT");
  const snap = await client.query(`SELECT COUNT(*)::int AS n FROM "ProductStateSnapshot"`);
  check("pre-assigned id satisfies FK in same transaction", snap.rows[0].n === 1);

  // --- 5. THE FAILURE MODE YOU FLAGGED -------------------------------------
  // Does a typo'd column in the AS(...) list throw, or silently yield NULL?
  let typoBehaviour = "unknown";
  try {
    await client.query(
      `SELECT r."priceMinCents", r."priceMinCets" AS typo
       FROM jsonb_to_recordset($1::jsonb) AS r("priceMinCents" int, "priceMinCets" int)`,
      [JSON.stringify([{ priceMinCents: 7900 }])],
    );
    const t = await client.query(
      `SELECT r."priceMinCets" AS typo
       FROM jsonb_to_recordset($1::jsonb) AS r("priceMinCets" int)`,
      [JSON.stringify([{ priceMinCents: 7900 }])],
    );
    typoBehaviour = t.rows[0].typo === null ? "SILENT NULL" : "value";
  } catch (e) {
    typoBehaviour = `THROWS: ${(e as Error).message.slice(0, 60)}`;
  }
  check(
    "typo'd column in AS(...) yields silent NULL, not an error",
    typoBehaviour === "SILENT NULL",
    `behaviour=${typoBehaviour}`,
  );

  // Would a silent NULL on a NOT NULL column be caught?
  let notNullCaught = false;
  try {
    await client.query(BULK_UPSERT, [
      JSON.stringify([{ ...row({ externalId: "p9" }), priceMinCents: undefined }]),
      "s1",
      NOW.toISOString(),
    ]);
  } catch (e) {
    notNullCaught = (e as Error).message.includes("null value");
  }
  check(
    "NOT NULL column catches a missing field at insert",
    notNullCaught,
    "so typos only go silent on NULLABLE columns",
  );

  // --- report ---------------------------------------------------------------
  console.log("");
  let failed = 0;
  for (const [name, pass, detail] of results) {
    if (!pass) failed++;
    console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`\n  ${results.length - failed}/${results.length} passed\n`);
  await client.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
