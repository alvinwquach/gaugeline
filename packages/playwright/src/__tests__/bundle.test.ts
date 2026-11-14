import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Options } from "tsup";
import { describe, expect, it } from "vitest";
import config from "../../tsup.config.js";

/**
 * What ships is one bundle of this package and the few core modules it uses. Core's own
 * dependencies (an HTML parser, a TypeScript compiler) have licences that must travel with them
 * and have no place in a Playwright helper, so no file from node_modules may reach the bundle.
 */
const BUDGET_BYTES = 100_000;

/** tsup reads `entry` as a glob, and a glob treats the backslashes of a Windows path as escapes. */
const forGlob = (path: string): string => path.replaceAll("\\", "/");

describe("the published bundle", () => {
  it("holds no third-party package and stays small", async () => {
    const out = mkdtempSync(join(tmpdir(), "gaugeline-pw-bundle-"));
    try {
      const options = (Array.isArray(config) ? config[0] : config) as Options;
      await build({
        ...options,
        entry: [forGlob(fileURLToPath(new URL("../index.ts", import.meta.url)))],
        config: false,
        outDir: forGlob(out),
        dts: false,
        clean: false,
        metafile: true,
        silent: true,
      });
      const meta = JSON.parse(readFileSync(join(out, "metafile-esm.json"), "utf8")) as {
        inputs: Record<string, unknown>;
        outputs: Record<string, { bytes: number; imports: { path: string; external?: boolean }[] }>;
      };
      const inputs = Object.keys(meta.inputs);
      expect(inputs.length).toBeGreaterThan(5); // the build really read the sources
      expect(inputs.filter((path) => path.split(/[\\/]/).includes("node_modules"))).toEqual([]);
      const outputs = Object.entries(meta.outputs).filter(([path]) => path.endsWith(".js"));
      expect(outputs).toHaveLength(1); // one file, no shared chunks
      const [, output] = outputs[0] ?? ["", { bytes: 0, imports: [] }];
      expect(output.bytes).toBeLessThan(BUDGET_BYTES);
      // Only Playwright (the user's own) and Node's built-ins are imported at run time.
      const imported = output.imports
        .map((i) => i.path)
        .filter((path) => path !== "@playwright/test");
      for (const path of imported)
        expect(
          path.startsWith("node:") ||
            !path.includes("/") ||
            [
              "http",
              "https",
              "net",
              "tls",
              "stream",
              "zlib",
              "async_hooks",
              "dns/promises",
            ].includes(path),
        ).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 120_000);
});
