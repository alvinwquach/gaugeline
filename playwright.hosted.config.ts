import { defineConfig } from "@playwright/test";

// The hosted app's browser specs. Each spec starts the app in its own process on a fresh Postgres database
// (GAUGELINE_TEST_DATABASE_URL), so there is no web server to start here and no docs build to wait for.
export default defineConfig({
  testDir: "e2e",
  testMatch: "hosted-*.spec.ts",
  tsconfig: "e2e/tsconfig.json",
  timeout: 30_000,
});
