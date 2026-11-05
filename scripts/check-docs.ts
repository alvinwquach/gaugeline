/**
 * Fail when a NAV slug has no file, a file has no NAV entry, or an internal link points nowhere.
 *   pnpm docs:check
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, UNLISTED } from "../docs/nav.js";
import { checkDocs, extractLinks } from "./lib/docs-check.js";

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (name.endsWith(".md") && name !== "index.md" && name !== "README.md") out.push(full);
  }
  return out;
}

const files = markdownFiles(docsDir).map((f) =>
  relative(docsDir, f).replace(/\\/g, "/").replace(/\.md$/, ""),
);
const problems = checkDocs({
  nav: NAV.flatMap((g) => g.pages.map((p) => ({ group: g.group, slug: p.slug }))),
  unlisted: UNLISTED.map((p) => p.slug),
  files,
  links: Object.fromEntries(
    files.map((f) => [f, extractLinks(readFileSync(join(docsDir, `${f}.md`), "utf8"), f)]),
  ),
});
for (const p of problems) process.stderr.write(`docs:check: ${p}\n`);
if (problems.length > 0) process.exitCode = 1;
else process.stdout.write(`docs:check: ${files.length} pages, every slug and link resolves.\n`);
