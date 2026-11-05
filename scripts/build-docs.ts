/**
 * Regenerate the flag table in docs/options.md from packages/cli/src/flags.ts.
 *   pnpm docs:flags          rewrite the block between <!-- flags:start --> and <!-- flags:end -->
 *   pnpm docs:flags:check    compare only; exit 1 on a difference
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLAGS, renderOptionsTable } from "../packages/cli/src/flags.js";
import { checkBlock, replaceBlock } from "./lib/marker-block.js";

const file = fileURLToPath(new URL("../docs/options.md", import.meta.url));
const text = readFileSync(file, "utf8");
const table = renderOptionsTable(FLAGS);
const result = process.argv.includes("--check")
  ? checkBlock(text, "flags", table)
  : replaceBlock(text, "flags", table);
if (!result.ok) {
  process.stderr.write(`docs:flags: ${result.error}\n`);
  process.exitCode = 1;
} else if (!process.argv.includes("--check")) {
  writeFileSync(file, result.text);
  process.stdout.write("docs:flags: docs/options.md updated.\n");
} else {
  process.stdout.write("docs:flags: docs/options.md is up to date.\n");
}
