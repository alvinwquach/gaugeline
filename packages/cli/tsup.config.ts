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
  dts: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
