import { defineConfig } from "vitest/config";

/**
 * Unit and integration suites are split deliberately. `npm test` must stay fast
 * and DB-free so it runs on every save; integration is opt-in and needs Postgres.
 *
 *   npm test              -> pure engine tests, no DB
 *   npm run test:integration -> requires docker-compose.test.yml + migrate deploy
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
