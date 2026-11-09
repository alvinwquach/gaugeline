import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // One tsconfig for every spec: the specs that run the app in-process load the built core, not its source.
  tsconfig: "e2e/tsconfig.json",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "pnpm docs:preview",
    url: "http://127.0.0.1:4173/docs/quick-start",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
