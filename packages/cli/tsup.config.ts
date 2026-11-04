import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  // One bundled file: the engine is inlined so `npx gaugeline` downloads one package.
  noExternal: ["@gaugeline/core"],
  dts: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
