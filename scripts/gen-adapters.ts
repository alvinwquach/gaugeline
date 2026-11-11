/**
 * Collects every adapter's entry file (packages/core/src/adapters/<id>.entry.ts) into the places that list
 * adapters (see lib/gen-adapters.ts), so adding an adapter adds files and edits no shared one.
 *   pnpm gen:adapters           write them
 *   pnpm gen:adapters --check   compare only; exit 1 when stale
 */
import { fileURLToPath } from "node:url";
import { generateAdapters } from "./lib/gen-adapters.js";

const root = process.env.GEN_ADAPTERS_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
process.exitCode = await generateAdapters(root, process.argv.includes("--check"));
