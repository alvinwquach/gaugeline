/**
 * Run every "$ npx gaugeline" example in the docs against its fixture and compare with the page.
 *   pnpm build && pnpm docs:examples [docs-dir]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, extractExamples, runExample, type Example } from "./lib/docs-examples.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const docsDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, "docs");
const bin = join(root, "packages/cli/dist/index.js");

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (n.startsWith(".") || n === "node_modules" || n === "__tests__") return [];
    return statSync(full).isDirectory() ? markdown(full) : n.endsWith(".md") ? [full] : [];
  });
}

let failed = 0;
const examples: Example[] = [];
for (const f of markdown(docsDir)) {
  try {
    examples.push(
      ...extractExamples(readFileSync(f, "utf8"), relative(root, f).replace(/\\/g, "/")),
    );
  } catch (err) {
    failed += 1;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
}
for (const e of examples) {
  try {
    const problem = compare(e, await runExample(e, bin));
    if (problem) {
      failed += 1;
      process.stderr.write(`${problem}\n`);
    } else {
      process.stdout.write(`ok ${e.file}:${e.line} ${e.command}\n`);
    }
  } catch (err) {
    failed += 1;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
}
process.stdout.write(`docs:examples: ${examples.length} examples, ${failed} problems\n`);
if (failed > 0) process.exitCode = 1;
