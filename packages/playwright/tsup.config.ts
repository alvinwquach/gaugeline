import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // The engine's fetcher and Sanity reader are inlined (core is not published); Playwright is the
  // user's own, a peer dependency, never bundled.
  noExternal: ["@gaugeline/core"],
  external: ["@playwright/test"],
  dts: true,
  clean: true,
  minify: true,
  keepNames: true,
  // Core's CommonJS dependencies call require() for Node built-ins: give the ESM bundle a real require.
  banner: {
    js: 'import { createRequire as __gaugelineCreateRequire } from "node:module";\nconst require = __gaugelineCreateRequire(import.meta.url);',
  },
});
