/**
 * docs/checks.data.json from the check registry, and docs/check-ids.lock.json (append-only).
 *   pnpm gen:checks           write both
 *   pnpm gen:checks --check   compare only; exit 1 when stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { catalogue, createPageRegistry } from "../packages/core/src/index.js";
import { format, resolveConfig } from "prettier";
import { updateLock } from "./lib/check-ids.js";
import { renderChecksTable, replaceChecksBlock } from "./lib/readme-checks.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataPath = process.env.GEN_CHECKS_DATA ?? `${root}docs/checks.data.json`;
const lockPath = process.env.GEN_CHECKS_LOCK ?? `${root}docs/check-ids.lock.json`;
const check = process.argv.includes("--check");
// The READMEs' check lists. A run pointed at temp data (GEN_CHECKS_DATA) leaves them alone unless asked.
const readmes = (
  process.env.GEN_CHECKS_READMES ??
  (process.env.GEN_CHECKS_DATA ? "" : `${root}README.md,${root}packages/cli/README.md`)
)
  .split(",")
  .filter((p) => p !== "");

const entries = catalogue(createPageRegistry());
// A scaffold from pnpm new:check imports and runs, but its TODO text must never reach the docs.
const unfinished = entries.flatMap((e) =>
  (["title", "what", "why", "fix", "tech"] as const)
    .filter((f) => e[f].trim().startsWith("TODO"))
    .map((f) => `${e.id} (${f})`),
);
if (unfinished.length > 0) {
  process.stderr
    .write(`gen:checks: TODO text left in ${unfinished.join(", ")}. Write the real text before merging.
`);
  process.exit(1);
}
const data = `${JSON.stringify(entries, null, 2)}\n`;
const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as string[]) : [];
const next = updateLock(
  lock,
  entries.map((e) => e.id),
);
if (!next.ok) {
  process.stderr.write(
    `gen:checks: ${next.missing.join(", ")} shipped before and is no longer registered. Check ids are a public interface: see STABILITY.md before removing one.\n`,
  );
  process.exitCode = 1;
} else {
  const lockText = `${JSON.stringify(next.lock, null, 2)}\n`;
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").replace(/\r\n/g, "\n") : "");
  const table = renderChecksTable(entries);
  // Formatted the way Prettier would, so gen:checks and format:check never disagree.
  const readmeText = await Promise.all(
    readmes.map(async (p) => ({
      p,
      next: await format(replaceChecksBlock(read(p), table, p), {
        ...((await resolveConfig(p)) ?? {}),
        filepath: p,
      }),
    })),
  );
  if (check) {
    if (read(dataPath) !== data || read(lockPath) !== lockText) {
      process.stderr.write("gen:checks: checks.data.json is stale, run pnpm gen:checks\n");
      process.exitCode = 1;
    }
    for (const { p, next } of readmeText) {
      if (read(p) !== next) {
        process.stderr.write(`gen:checks: the check list in ${p} is stale, run pnpm gen:checks\n`);
        process.exitCode = 1;
      }
    }
  } else {
    writeFileSync(dataPath, data);
    writeFileSync(lockPath, lockText);
    for (const { p, next } of readmeText) writeFileSync(p, next);
    process.stdout.write(`gen:checks: ${entries.length} checks written to docs/checks.data.json\n`);
  }
}
