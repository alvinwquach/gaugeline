import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // One bundled file, like the gaugeline CLI: the engine (and the CLI's launch command) is inlined.
  noExternal: ["@gaugeline/core"],
  dts: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
