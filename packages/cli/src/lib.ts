/**
 * The package's public entry: what a gaugeline.config.ts or .mjs imports.
 *   import { defineCheck } from "gaugeline";
 * The bin (dist/index.js) is a different file; importing this one runs nothing. Its types are
 * lib-types.d.ts, copied to dist/lib.d.ts by the build (src/__tests__/lib-types.test.ts keeps
 * them in step with core's).
 */
export { defineCheck } from "@gaugeline/core";
