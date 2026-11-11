import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every package that inlines @gaugeline/core into one ESM file also inlines its CommonJS dependencies
 * (`yaml` calls require("process")). esbuild's require shim throws at start-up unless the bundle has a
 * real `require`, so each such tsup config must carry the createRequire banner. The packed-tarball smoke
 * test (scripts/smoke.ts) starts both bundles, but only in CI; this one fails in the unit run.
 */
const root = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, root)), "utf8");

describe.each(["packages/cli/tsup.config.ts", "packages/free/tsup.config.ts"])("%s", (path) => {
  const config = read(path);

  it("inlines the engine, so it needs a real require for the CommonJS packages inside it", () => {
    expect(config).toContain('noExternal: ["@gaugeline/core"');
  });

  it("gives the ESM bundle a real require, after the shebang", () => {
    expect(config).toContain("#!/usr/bin/env node\\nimport { createRequire");
    expect(config).toContain("const require = __gaugelineCreateRequire(import.meta.url);");
  });
});
