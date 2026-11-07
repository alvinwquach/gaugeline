import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@gaugeline/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@gaugeline/app-server": fileURLToPath(
        new URL("./packages/app-server/src/index.ts", import.meta.url),
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
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 20000,
    // Reserved names (.test, .example, ...) never reach a real resolver in any test.
    setupFiles: ["packages/testkit/src/no-real-dns.ts"],
  },
});
