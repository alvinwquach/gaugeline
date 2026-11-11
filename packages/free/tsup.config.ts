import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Chunks, like the gaugeline CLI (see packages/cli/tsup.config.ts): one chunk per content adapter, loaded on use.
  splitting: true,
  // The engine (and the CLI's launch command) is inlined.
  noExternal: ["@gaugeline/core"],
  // The TypeScript compiler (9 MB) is loaded only by `gaugeline query`, from beside the package: an optional
  // peer dependency, never bundled. It would be most of the tarball and the size budget forbids it.
  external: ["typescript"],
  dts: false,
  clean: true,
  minify: true,
  keepNames: true,
  // `yaml` is CommonJS and calls require() for Node built-ins: give the ESM bundle a real require.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __gaugelineCreateRequire } from "node:module";\nconst require = __gaugelineCreateRequire(import.meta.url);',
  },
});
