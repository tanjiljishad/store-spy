/**
 * Preflight for the integration suite — runs once per test worker, before any
 * test file is imported (so before any `beforeEach` TRUNCATE can fire).
 *
 * Every integration test truncates shared tables in `beforeEach`. If
 * DATABASE_URL points anywhere other than the disposable docker-compose
 * Postgres, that TRUNCATE silently wipes a real database. Individual test
 * files carry a loose `/test/i` guard; this is the strict, central one:
 * the host port and database name must match the compose service exactly,
 * or the whole run aborts loudly here.
 *
 * If you change the published port or DB name, update every copy:
 *   - docker-compose.test.yml   (ports + healthcheck)
 *   - .env.test.example         (committed)
 *   - .env.test                 (each dev's local, gitignored)
 *   - the constants below
 */

const EXPECTED_PORT = "5433";
const EXPECTED_DB = "ecom_intel_test";

const raw = process.env.DATABASE_URL;
if (!raw) {
  throw new Error(
    "Integration preflight: DATABASE_URL is unset. Run via `npm run test:integration` " +
      "(which loads .env.test), after `npm run db:test:up && npm run db:test:migrate`.",
  );
}

let parsed: URL;
try {
  parsed = new URL(raw);
} catch {
  throw new Error(`Integration preflight: DATABASE_URL is not a valid URL: ${raw}`);
}

const port = parsed.port || "5432";
const dbName = parsed.pathname.replace(/^\//, "");

const problems: string[] = [];
if (port !== EXPECTED_PORT) {
  problems.push(`port is ${port}, expected ${EXPECTED_PORT} (the docker-compose.test.yml published port)`);
}
if (dbName !== EXPECTED_DB) {
  problems.push(`database is "${dbName}", expected "${EXPECTED_DB}"`);
}

if (problems.length > 0) {
  throw new Error(
    "Integration preflight FAILED — refusing to run a suite that TRUNCATEs shared tables against the wrong database.\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\n  DATABASE_URL = ${raw}\n` +
      "  Expected the disposable Postgres from docker-compose.test.yml. " +
      "Check .env.test, or run `npm run db:test:up`.",
  );
}
