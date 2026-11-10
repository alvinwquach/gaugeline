/**
 * Migration guides. A change is BREAKING when its changeset is a major bump or has a line that starts
 * with `BREAKING:`. A breaking change must carry a `Migration: <slug>` line, and docs/migrations/<slug>.md
 * must exist. The same rule applies to the released history (packages/cli/CHANGELOG.md and the
 * hand-backfilled entries in docs/changelog.data.json), so a guide cannot be deleted later either.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanChangelog, splitItem } from "./changelog.js";
import { parseChangeset, type Bump } from "./gate.js";

export { splitItem };

export const MIGRATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface PendingChangeset {
  file: string;
  bump: Bump;
  summary: string;
}

const BREAKING_LINE = /^BREAKING:/;
const MIGRATION_LINE = /^Migration:\s*(.*?)\.?\s*$/;

/** Changesets that are breaking: a major bump, or a line starting `BREAKING:`. "(internal)" notes never are. */
export function breakingChangesets(changesets: readonly PendingChangeset[]): PendingChangeset[] {
  return changesets.filter(
    (c) =>
      !c.summary.trim().startsWith("(internal)") &&
      (c.bump === "major" || c.summary.split(/\r?\n/).some((l) => BREAKING_LINE.test(l.trim()))),
  );
}

/** The value of each `Migration:` line (trailing full stop removed). */
function migrationValues(lines: readonly string[]): string[] {
  return lines.flatMap((l) => {
    const m = MIGRATION_LINE.exec(l.trim());
    return m ? [m[1] ?? ""] : [];
  });
}

export function listMigrations(root: string): { slug: string; title: string }[] {
  const dir = join(root, "docs/migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -3))
    .sort()
    .map((slug) => {
      const text = readFileSync(join(dir, `${slug}.md`), "utf8");
      return { slug, title: /^# (.+)$/m.exec(text)?.[1]?.trim() ?? slug };
    });
}

function readPending(root: string): PendingChangeset[] {
  const dir = join(root, ".changeset");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => ({
      file: `.changeset/${f}`,
      ...parseChangeset(readFileSync(join(dir, f), "utf8")),
    }));
}

/** Every problem with the breaking changes in the pending changesets and in the released history. */
export function checkMigrations(root: string): string[] {
  const guides = new Set(listMigrations(root).map((g) => g.slug));
  const problems: string[] = [];
  const verify = (where: string, lines: readonly string[]): void => {
    const slugs = migrationValues(lines);
    if (slugs.length === 0) {
      problems.push(
        `${where} is a breaking change with no guide. Write docs/migrations/<slug>.md and add a line "Migration: <slug>".`,
      );
    }
    for (const slug of slugs) {
      if (!MIGRATION_SLUG.test(slug))
        problems.push(
          `${where}: Migration: "${slug}" is not a slug (lowercase words joined by hyphens).`,
        );
      else if (!guides.has(slug))
        problems.push(
          `${where}: Migration: ${slug}, but docs/migrations/${slug}.md does not exist.`,
        );
    }
  };
  for (const c of breakingChangesets(readPending(root))) verify(c.file, c.summary.split(/\r?\n/));

  const log = join(root, "packages/cli/CHANGELOG.md");
  if (existsSync(log)) {
    for (const i of scanChangelog(readFileSync(log, "utf8")).items) {
      if (i.text.startsWith("(internal)")) continue;
      if (i.section === "major" || i.lines.some((l) => BREAKING_LINE.test(l)))
        verify(`Released ${i.version} ("${i.text.slice(0, 50)}")`, i.lines);
    }
  }
  const data = join(root, "docs/changelog.data.json");
  if (existsSync(data)) {
    for (const e of JSON.parse(readFileSync(data, "utf8")) as {
      version: string;
      items: string[];
    }[])
      for (const text of e.items)
        if (BREAKING_LINE.test(text))
          verify(`Released ${e.version} ("${text.slice(0, 50)}")`, [
            text,
            ...migrationLinesIn(text),
          ]);
  }
  return [...new Set(problems)];
}

/** In a joined item the Migration line is part of the text: pull it back out as its own line. */
function migrationLinesIn(text: string): string[] {
  const m = splitItem(text).migration;
  return m ? [`Migration: ${m}`] : [];
}
