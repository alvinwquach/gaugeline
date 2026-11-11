/**
 * The generated parts of skills/gaugeline from docs/checks.data.json (itself generated from the check registry).
 *   pnpm gen:skill           write them
 *   pnpm gen:skill --check   compare only; exit 1 when stale
 * The table of findings is the whole of references/findings.md between its markers; SKILL.md carries the count
 * of checks per area between its own markers. Everything outside the markers is hand-written and left alone.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { renderAreaTable, renderFindingsTable, type SkillCheck } from "./lib/gen-skill.js";
import { firstDifference, replaceBlock } from "./lib/marker-block.js";

const root = process.env.GEN_SKILL_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.includes("--check");

const checks = JSON.parse(
  readFileSync(join(root, "docs/checks.data.json"), "utf8"),
) as SkillCheck[];
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const targets = [
  { file: "skills/gaugeline/SKILL.md", block: "skill-areas", table: renderAreaTable(checks) },
  {
    file: "skills/gaugeline/references/findings.md",
    block: "skill-findings",
    table: renderFindingsTable(checks),
  },
];

let failed = false;
for (const t of targets) {
  const path = join(root, t.file);
  if (!existsSync(path)) {
    process.stderr.write(`gen:skill: ${t.file} is missing.\n`);
    failed = true;
    continue;
  }
  const current = read(path);
  const replaced = replaceBlock(current, t.block, t.table);
  if (!replaced.ok) {
    process.stderr.write(`gen:skill: ${t.file}: ${replaced.error}\n`);
    failed = true;
    continue;
  }
  // Formatted the way Prettier would, so gen:skill and format:check never disagree.
  const next = await format(replaced.text, {
    ...((await resolveConfig(path)) ?? {}),
    filepath: path,
  });
  if (check) {
    if (current !== next) {
      process.stderr.write(
        `gen:skill: ${t.file} is stale (${firstDifference(current, next) ?? "differs"}), run pnpm gen:skill\n`,
      );
      failed = true;
    }
  } else {
    writeFileSync(path, next);
    process.stdout.write(`gen:skill: ${t.file} written (${checks.length} checks)\n`);
  }
}
if (failed) process.exitCode = 1;
