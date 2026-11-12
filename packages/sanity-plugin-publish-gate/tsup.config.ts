import { defineConfig } from "tsup";

export default defineConfig({
  // index is browser-safe (the resolver); function is Node (the checks).
  entry: ["src/index.ts", "src/function.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  // The engine is inlined, so the Function runs the same check code as the gaugeline CLI.
  noExternal: ["@gaugeline/core"],
  // The TypeScript compiler (9 MB) is loaded only by `gaugeline query`: never bundled here.
  external: ["typescript"],
  dts: true,
  clean: true,
  minify: true,
  keepNames: true,
  // `yaml` is CommonJS and calls require() for Node built-ins: give the ESM bundle a real require.
  banner: {
    js: 'import { createRequire as __gaugelineCreateRequire } from "node:module";\nconst require = __gaugelineCreateRequire(import.meta.url);',
  },
});
