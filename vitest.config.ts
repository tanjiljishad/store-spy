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
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
