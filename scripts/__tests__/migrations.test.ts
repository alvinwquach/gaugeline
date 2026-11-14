import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { nodeVersionProblem } from "../../packages/cli/src/node-version.js";
import { scanChangelog } from "../lib/changelog.js";
import {
  breakingChangesets,
  checkMigrations,
  listMigrations,
  splitItem,
} from "../lib/migrations.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0))
    rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A repository layout with the files the check reads. */
function tempRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-migrations-"));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const GUIDE = "# Node 22 and newer\n\nWhat to change.\n";
const minor = (body: string) => `---\n"gaugeline": minor\n---\n\n${body}\n`;
const major = (body: string) => `---\n"gaugeline": major\n---\n\n${body}\n`;

describe("migration guides: unit", () => {
  it("a major bump is breaking; so is a BREAKING: line; a minor or patch is not", () => {
    const found = breakingChangesets([
      { file: "a.md", bump: "major", summary: "Removes the old flag." },
      { file: "b.md", bump: "minor", summary: "BREAKING: Needs Node 22." },
      { file: "c.md", bump: "minor", summary: "Adds a check.\nBREAKING: The id changed." },
      { file: "d.md", bump: "minor", summary: "Adds a check." },
      { file: "e.md", bump: "patch", summary: "Mentions that breaking changes are listed." },
      { file: "f.md", bump: "none", summary: "(internal) Not breaking: it is a refactor." },
    ]);
    expect(found.map((c) => c.file)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("splitItem reads the BREAKING: prefix and the Migration: line, and keeps the sentence", () => {
    expect(splitItem("BREAKING: Gaugeline now needs Node 22 or newer. Migration: node-22")).toEqual(
      { breaking: true, body: "Gaugeline now needs Node 22 or newer.", migration: "node-22" },
    );
    expect(splitItem("Adds a check.")).toEqual({
      breaking: false,
      body: "Adds a check.",
      migration: null,
    });
    // A trailing full stop on the slug (so a one-sentence summary still ends in one) is not part of it.
    expect(splitItem("BREAKING: Renames the flag. Migration: rename-flag.").migration).toBe(
      "rename-flag",
    );
  });

  it("scanChangelog keeps the section of every item and the raw lines", () => {
    const items = scanChangelog(
      "## 1.0.0\n\n### Major Changes\n\n- ab12cd3: Removes the flag.\n  Migration: flag-gone\n\n### Minor Changes\n\n- Adds a check.\n",
    );
    expect(items.items).toEqual([
      {
        version: "1.0.0",
        section: "major",
        text: "Removes the flag. Migration: flag-gone",
        lines: ["Removes the flag.", "Migration: flag-gone"],
      },
      { version: "1.0.0", section: "minor", text: "Adds a check.", lines: ["Adds a check."] },
    ]);
    expect(items.versions).toEqual(["1.0.0"]);
  });

  it("listMigrations reads the title from the first heading", () => {
    const dir = tempRoot({
      "docs/migrations/node-22.md": GUIDE,
      "docs/migrations/other.md": "No heading here.\n",
    });
    expect(listMigrations(dir)).toEqual([
      { slug: "node-22", title: "Node 22 and newer" },
      { slug: "other", title: "other" },
    ]);
  });
});

describe("migration guides: pending changesets and the released history", () => {
  it("a pending breaking changeset with no guide fails, and names the file and the fix", () => {
    const dir = tempRoot({
      ".changeset/drop-flag.md": minor("BREAKING: The --old flag is gone."),
    });
    const problems = checkMigrations(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(".changeset/drop-flag.md");
    expect(problems[0]).toContain("Migration: <slug>");
  });

  it("the same changeset passes once it names a guide that exists", () => {
    const dir = tempRoot({
      ".changeset/drop-flag.md": minor("BREAKING: The --old flag is gone.\nMigration: drop-flag"),
      "docs/migrations/drop-flag.md": "# The --old flag is gone\n",
    });
    expect(checkMigrations(dir)).toEqual([]);
  });

  it("naming a guide that does not exist fails", () => {
    const dir = tempRoot({
      ".changeset/drop-flag.md": minor("BREAKING: The --old flag is gone.\nMigration: drop-flag"),
    });
    expect(checkMigrations(dir).join("\n")).toContain(
      "docs/migrations/drop-flag.md does not exist",
    );
  });

  it("a major bump needs a guide even without the BREAKING: word", () => {
    const dir = tempRoot({ ".changeset/big.md": major("Everything changes.") });
    expect(checkMigrations(dir)).toHaveLength(1);
  });

  it("a slug that is not a plain slug is refused, so it cannot point outside docs/migrations", () => {
    for (const bad of ["../secrets", "Node 22", "a/b", "node_22"]) {
      const dir = tempRoot({
        ".changeset/x.md": minor(`BREAKING: Changes.\nMigration: ${bad}`),
        "docs/migrations/x.md": GUIDE,
      });
      expect(checkMigrations(dir).join("\n"), bad).toContain("is not a slug");
    }
  });

  it("a non-breaking changeset needs nothing, with or without a Migration line", () => {
    const dir = tempRoot({
      ".changeset/ok.md": minor("Adds a check."),
      ".changeset/ok2.md": minor("Adds a flag.\nMigration: not-needed"),
    });
    expect(checkMigrations(dir)).toEqual([]);
  });

  it("the released changelog is checked too: a released breaking entry with no guide fails", () => {
    const dir = tempRoot({
      "packages/cli/CHANGELOG.md":
        "# gaugeline\n\n## 1.0.0\n\n### Major Changes\n\n- 1a2b3c4: Removes the flag.\n\n## 0.9.0\n\n### Minor Changes\n\n- 5d6e7f8: BREAKING: Renames a check id.\n",
    });
    const problems = checkMigrations(dir);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("1.0.0");
    expect(problems.join("\n")).toContain("0.9.0");
  });

  it("the released changelog passes when every breaking entry links an existing guide", () => {
    const dir = tempRoot({
      "packages/cli/CHANGELOG.md":
        "# gaugeline\n\n## 1.0.0\n\n### Major Changes\n\n- 1a2b3c4: Removes the flag.\n  Migration: flag-gone\n",
      "docs/migrations/flag-gone.md": "# The flag is gone\n",
    });
    expect(checkMigrations(dir)).toEqual([]);
  });

  it("the backfilled history in docs/changelog.data.json is checked as well", () => {
    const dir = tempRoot({
      "docs/changelog.data.json": JSON.stringify([
        { version: "0.1.1", date: "2026-09-23", headline: null, items: ["BREAKING: Gone."] },
      ]),
    });
    expect(checkMigrations(dir).join("\n")).toContain("0.1.1");
  });

  it("(internal) entries never need a guide", () => {
    const dir = tempRoot({
      ".changeset/refactor.md":
        "---\n---\n\n(internal) BREAKING: this is only a word in a refactor note.\n",
    });
    expect(checkMigrations(dir)).toEqual([]);
  });
});

describe("migration guides: this repository", () => {
  it("every breaking pending changeset and every breaking released entry has its guide", () => {
    expect(checkMigrations(repoRoot)).toEqual([]);
  });

  it("the Node 22 guide exists and prints the exact message the CLI prints under an older Node", () => {
    const text = readFileSync(join(repoRoot, "docs/migrations/node-22.md"), "utf8");
    expect(text.startsWith("# Node 22 and newer")).toBe(true);
    expect(text).toContain(nodeVersionProblem("20.18.0") ?? "unreachable");
    expect(text).toMatch(/exit(s|ed)? (with )?(code )?2/i);
    for (const where of ["engines", ".nvmrc", "Vercel", "Netlify", "GitHub Actions"])
      expect(text, where).toContain(where);
  });

  it("the Node 22 changeset, while it is pending, is breaking and points at the guide", () => {
    const path = join(repoRoot, ".changeset/chore-node-22-24.md");
    if (!existsSync(path)) return; // released: the changelog check above covers it
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^BREAKING: /m);
    expect(text).toMatch(/^Migration: node-22$/m);
  });
});
