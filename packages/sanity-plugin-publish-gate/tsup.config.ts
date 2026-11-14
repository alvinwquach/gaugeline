import { fileURLToPath } from "node:url";
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
  // index is browser-safe (the resolver, the request and the reply check): it imports no Node module, so it gets no banner and no shared chunk.
  {
    ...common,
    entry: ["src/index.ts"],
    clean: true,
    // The Studio needs only the shared text cleaner (N17), not the whole engine: in this entry
    // "@gaugeline/core" is that one module, so nothing else of core reaches the browser bundle.
    noExternal: ["@gaugeline/core"],
    esbuildOptions(options) {
      options.alias = {
        "@gaugeline/core": fileURLToPath(new URL("../core/src/untrusted.ts", import.meta.url)),
      };
    },
  },
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
