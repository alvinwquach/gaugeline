/**
 * packages/cli/CHANGELOG.md -> docs/changelog.data.json and docs/changelog.md.
 *   pnpm docs:changelog            write both
 *   pnpm docs:changelog --check    compare only; exit 1 on a difference
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  mergeEntries,
  parseChangelog,
  renderChangelogPage,
  type ChangelogEntry,
} from "./lib/changelog.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const changelogPath = `${root}packages/cli/CHANGELOG.md`;
const backfill = JSON.parse(
  readFileSync(`${root}docs/changelog.backfill.json`, "utf8"),
) as ChangelogEntry[];

/** The date of the v<version> tag, if it exists. */
function tagDate(version: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", `v${version}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const generated: ChangelogEntry[] = existsSync(changelogPath)
  ? parseChangelog(readFileSync(changelogPath, "utf8")).map((e) => ({
      ...e,
      date: tagDate(e.version),
    }))
  : [];
const entries = mergeEntries(generated, backfill);
const files: Record<string, string> = {
  "docs/changelog.data.json": `${JSON.stringify(entries, null, 2)}\n`,
  "docs/changelog.md": renderChangelogPage(entries),
};
if (process.argv.includes("--check")) {
  const stale = Object.entries(files).filter(
    ([f, text]) =>
      !existsSync(`${root}${f}`) ||
      readFileSync(`${root}${f}`, "utf8").replace(/\r\n/g, "\n") !== text,
  );
  if (stale.length > 0) {
    process.stderr.write(
      `docs:changelog: ${stale.map(([f]) => f).join(", ")} out of date. Run pnpm docs:changelog.\n`,
    );
    process.exitCode = 1;
  }
} else {
  for (const [f, text] of Object.entries(files)) writeFileSync(`${root}${f}`, text);
  process.stdout.write("docs:changelog: wrote docs/changelog.data.json and docs/changelog.md\n");
}
