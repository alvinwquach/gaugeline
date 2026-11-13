import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build is embedded in the CLI package by scripts/embed-client.mjs and served from memory by
// packages/app-server. Relative base: the app answers at the root of whatever port it got.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Never published: a source map is the source, and nothing in the browser needs it.
    sourcemap: false,
    // Hashed file names for JS and CSS (the Vite default: assets/[name]-[hash].ext), stated here so
    // a change of default shows up in review. Nothing is inlined: the policy has no inline script or style.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        // The text of every check (what it catches, why, how to fix it) grows with each check Gaugeline
        // ships, and is most of the app. It is its own file, so no single file nears the size limit in
        // scripts/embed-client.mjs. The entry still imports it: nothing loads later or differently.
        manualChunks(id) {
          if (id.endsWith("/src/check-titles.ts")) return "check-text";
          return undefined;
        },
      },
    },
  },
});
