import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration runs are SINGLE-THREADED *and* single-file-at-a-time on
 * purpose: every test truncates shared tables in beforeEach, so parallel
 * files — not just parallel threads — would wipe each other's fixtures and
 * produce flakes that look like real concurrency bugs. `singleThread` alone
 * only pins worker count to one; Vitest can still interleave multiple test
 * files' async execution within that one thread unless fileParallelism is
 * also turned off.
 *
 * The one test that genuinely needs concurrency drives it explicitly with
 * Promise.allSettled inside a single test body.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
