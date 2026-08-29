import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Unit and integration suites are split deliberately. `npm test` must stay fast
 * and DB-free so it runs on every save; integration is opt-in and needs Postgres.
 *
 *   npm test              -> pure engine tests, no DB
 *   npm run test:integration -> requires docker-compose.test.yml + migrate deploy
 *
 * The `@` alias mirrors vitest.integration.config.ts's — added when the first
 * unit test needed to import a route file (which uses `@/...` imports, unlike
 * plain src/lib modules, which use relative imports and never needed this).
 *
 * import.meta.dirname (not __dirname): Vite's forthcoming native config loader
 * doesn't provide the CJS __dirname global. Node >= 20.11 / 22 has this.
 *
 * Pool is left at the Vitest 4 default (`forks`); see the note in
 * vitest.integration.config.ts for why `threads` is avoided.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    // TRUSTED_PROXY_HOPS has no default (security/rate-limit.ts). Pin it for
    // the suite so getClientIp() behaves deterministically — a "single proxy
    // in front" topology, matching what most route tests assume when they
    // set an x-forwarded-for header. rate-limit.test.ts deletes it within
    // specific test bodies to exercise the unset path.
    env: { TRUSTED_PROXY_HOPS: "1" },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
