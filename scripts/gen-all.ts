/**
 * Every generator, in order. Branches do not commit the result; see CONTRIBUTING.md, "Generated files".
 *   pnpm gen:all                       write them all
 *   pnpm gen:all --no-surface          skip the public-surface rules (build and test jobs)
 *   pnpm gen:all --base <git-ref>      compare the public surface with that ref's lock file (a pull request's base)
 *   pnpm gen:all --restore [<ref>]     put the generated files back to <ref> (default origin/main) before you commit
 */
import { fileURLToPath } from "node:url";
import { parseGenAllArgs, restoreGenerated, runGenAll } from "./lib/gen-all.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cmd = parseGenAllArgs(process.argv.slice(2));
if (cmd.kind === "error") {
  process.stderr.write(`gen:all: ${cmd.message}\n`);
  process.exitCode = 1;
} else
  process.exitCode =
    cmd.kind === "restore" ? restoreGenerated(root, cmd.ref) : runGenAll(root, cmd.opts);
