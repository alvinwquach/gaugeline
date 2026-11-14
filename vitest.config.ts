import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The app's component tests wait longer on a loaded runner (packages/app/src/test-setup.ts). The scripts'
// tests run vitest in a temporary copy of the repository that has no app, so the file is optional.
const appSetup = fileURLToPath(new URL("./packages/app/src/test-setup.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gaugeline/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@gaugeline/app-server": fileURLToPath(
        new URL("./packages/app-server/src/index.ts", import.meta.url),
      ),
      "@gaugeline/renderer": fileURLToPath(
        new URL("./packages/renderer/src/index.ts", import.meta.url),
      ),
      "@gaugeline/testkit": fileURLToPath(
        new URL("./packages/testkit/src/index.ts", import.meta.url),
      ),
      "@gaugeline/fixtures": fileURLToPath(
        new URL("./packages/fixtures/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "apps/*/db/**/*.test.ts",
      "apps/*/app/**/*.test.ts",
      "apps/*/worker/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    testTimeout: 20000,
    // Reserved names (.test, .example, ...) never reach a real resolver in any test.
    setupFiles: [
      "packages/testkit/src/no-real-dns.ts",
      ...(existsSync(appSetup) ? [appSetup] : []),
    ],
  },
});
