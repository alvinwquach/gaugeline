import { defineConfig } from "vitest/config";

/** Tests over the built docs site; run after `pnpm docs:build`, in the Docs workflow. */
export default defineConfig({
  test: { include: ["docs/__tests__/**/*.test.ts"], testTimeout: 30000 },
});
