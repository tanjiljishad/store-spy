import { defineConfig } from "vitest/config";
import path from "node:path";

// import.meta.dirname (not __dirname): Vite's forthcoming native config loader
// doesn't provide the CJS __dirname global. Node >= 20.11 / 22 has this.

/**
 * Integration runs are SINGLE-WORKER *and* single-file-at-a-time on purpose:
 * every test truncates shared tables in beforeEach, so parallel files — not
 * just parallel workers — would wipe each other's fixtures and produce flakes
 * that look like real concurrency bugs.
 *
 * Pool is `forks` (the Vitest 4 default): the `threads` pool segfaults under
 * Vitest 4 / Node 24 on this project (crash during collection, before any test
 * runs). Process-level isolation is the better fit for DB integration tests
 * anyway. Vitest 4 also removed `poolOptions` (the old `threads.singleThread`
 * knob) — a single worker is now `maxWorkers: 1` (see vitest.dev
 * migration#pool-rework), and `fileParallelism: false` stops Vitest
 * interleaving multiple test files' async execution within that one worker.
 *
 * The one test that genuinely needs concurrency drives it explicitly with
 * Promise.allSettled inside a single test body.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Aborts loudly if DATABASE_URL isn't the disposable compose Postgres,
    // before any beforeEach TRUNCATE can touch the wrong database.
    setupFiles: ["./vitest.integration.setup.ts"],
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // TRUSTED_PROXY_HOPS has no default (security/rate-limit.ts) and
    // production refuses to boot without it. Pin it here so route
    // integration tests that key rate limits on an x-forwarded-for header
    // see the "single proxy in front" behaviour they were written against.
    env: { TRUSTED_PROXY_HOPS: "1" },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
