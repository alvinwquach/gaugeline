import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/lib.ts"],
  format: ["esm"],
  // Chunks, so start-up reads only what the run uses: the version guard in index.ts (a few hundred bytes, so
  // `npx gaugeline` on an old Node still prints its message before anything else is parsed) imports main by a
  // dynamic import, and each content adapter is its own chunk, imported by its loader in
  // packages/core/src/adapters/registry.ts the first time a run uses it. Shared code (the fetcher, the
  // redactors, the sitemap reader) lands in shared chunks. The tarball allows dist/.+ (scripts/smoke.ts).
  splitting: true,
  target: "node22",
  platform: "node",
  // The engine is inlined (not a dependency), so `npx gaugeline` downloads one package.
  noExternal: ["@gaugeline/core", "@gaugeline/app-server"],
  // The TypeScript compiler (9 MB) is loaded only by `gaugeline query`, from beside the package: an optional
  // peer dependency, never bundled. It would be most of the tarball and the size budget forbids it.
  external: ["typescript"],
  dts: false,
  clean: true,
  // The types of the public entry are written by hand (src/lib-types.d.ts): the engine is bundled, not installed.
  onSuccess: async () => {
    copyFileSync("src/lib-types.d.ts", "dist/lib.d.ts");
  },
  minify: true,
  keepNames: true,
  // `yaml` is CommonJS and calls require() for Node built-ins: give the ESM bundle a real require.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __gaugelineCreateRequire } from "node:module";\nconst require = __gaugelineCreateRequire(import.meta.url);',
  },
});
