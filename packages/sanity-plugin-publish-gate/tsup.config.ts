import { defineConfig } from "tsup";

const common = {
  format: ["esm"] as ["esm"],
  target: "node22",
  platform: "node" as const,
  dts: true,
  minify: true,
  keepNames: true,
};

export default defineConfig([
  // index is browser-safe (the resolver): it imports nothing, so it gets no banner and no shared chunk.
  { ...common, entry: ["src/index.ts"], clean: true },
  {
    ...common,
    entry: ["src/function.ts"],
    clean: false,
    splitting: true,
    // The engine is inlined, so the Function runs the same check code as the gaugeline CLI.
    noExternal: ["@gaugeline/core"],
    // The TypeScript compiler (9 MB) is loaded only by `gaugeline query`: never bundled here.
    external: ["typescript"],
    // `yaml` is CommonJS and calls require() for Node built-ins: give the ESM bundle a real require.
    banner: {
      js: 'import { createRequire as __gaugelineCreateRequire } from "node:module";\nconst require = __gaugelineCreateRequire(import.meta.url);',
    },
  },
]);
