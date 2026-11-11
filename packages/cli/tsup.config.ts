import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // The version guard in index.ts loads main.js with a dynamic import; keep it in the one bundled file.
  splitting: false,
  target: "node22",
  platform: "node",
  // One bundled file: the engine is inlined so `npx gaugeline` downloads one package.
  noExternal: ["@gaugeline/core", "@gaugeline/app-server"],
  // The TypeScript compiler (9 MB) is loaded only by `gaugeline query`, from beside the package: an optional
  // peer dependency, never bundled. It would be most of the tarball and the size budget forbids it.
  external: ["typescript"],
  dts: false,
  clean: true,
  // `yaml` is CommonJS and calls require() for Node built-ins: give the ESM bundle a real require.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __gaugelineCreateRequire } from "node:module";\nconst require = __gaugelineCreateRequire(import.meta.url);',
  },
});
