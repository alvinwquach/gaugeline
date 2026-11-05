// check-community: allow-email (invented addresses at reserved example domains, used by the test)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mergeEntries, parseChangelog, renderChangelogPage } from "../lib/changelog.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const TWO_VERSIONS = `# gaugeline

## 0.2.0

### Minor Changes

- 1a2b3c4: Headline: Launches and prices
- 5d6e7f8: Checks the 301 map against the plan.

### Patch Changes

- 9a8b7c6: Fixes a wrong count in the summary line,
  which now matches the report.
- (internal) Refactors the runner.

## 0.1.0

### Minor Changes

- One command checks a page.
`;

describe("changelog-to-docs: unit", () => {
  it("a CHANGELOG.md with two versions gives two entries, newest first", () => {
    const entries = parseChangelog(TWO_VERSIONS);
    expect(entries.map((e) => e.version)).toEqual(["0.2.0", "0.1.0"]);
  });

  it('a "Headline:" line becomes the headline and is not repeated in items', () => {
    const [latest] = parseChangelog(TWO_VERSIONS);
    expect(latest?.headline).toBe("Launches and prices");
    expect(latest?.items.join(" ")).not.toContain("Headline");
  });

  it("minor and patch sections merge into one items list, minor first; continuation lines join", () => {
    const [latest] = parseChangelog(TWO_VERSIONS);
    expect(latest?.items).toEqual([
      "Checks the 301 map against the plan.",
      "Fixes a wrong count in the summary line, which now matches the report.",
    ]);
  });

  it('summaries starting "(internal)" are left out of items', () => {
    expect(
      parseChangelog(TWO_VERSIONS)
        .flatMap((e) => e.items)
        .some((i) => i.includes("(internal)")),
    ).toBe(false);
  });

  it("backfilled entries are merged without duplicating a version the changelog has", () => {
    const merged = mergeEntries(
      [{ version: "0.1.0", date: null, headline: null, items: ["generated"] }],
      [
        { version: "0.1.0", date: "2026-09-22", headline: "The site check", items: ["backfill"] },
        { version: "0.1.1", date: "2026-09-23", headline: "Later", items: ["x"] },
      ],
    );
    expect(merged.map((e) => [e.version, e.items[0]])).toEqual([
      ["0.1.1", "x"],
      ["0.1.0", "generated"],
    ]);
  });

  it("the committed docs data: the real 0.1.0 replaces the backfilled one, 0.1.1 stays", () => {
    const data = JSON.parse(readFileSync(join(repoRoot, "docs/changelog.data.json"), "utf8")) as {
      version: string;
      headline: string;
      date: string;
    }[];
    // A version the real changelog has wins over the backfill: 0.1.0 is this repository's release,
    // not yet tagged (no date), under the site's headline.
    const real = data.find((e) => e.version === "0.1.0") as { items: string[] } & Record<
      string,
      unknown
    >;
    expect(real).toMatchObject({ headline: "The site check", date: null });
    expect(real.items.some((i) => i.startsWith("Image checks:"))).toBe(true);
    expect(data.find((e) => e.version === "0.1.1")).toMatchObject({
      headline: "Launches, delivery and generated content",
      date: "2026-09-23",
    });
  });
});

/** A throwaway copy of the workspace layout with the real node_modules linked in. */
function tempRepo(packages: Record<string, string>, fixed: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-changesets-"));
  temps.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp-root", private: true }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  for (const [name, version] of Object.entries(packages)) {
    mkdirSync(join(dir, "packages", name), { recursive: true });
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({ name, version }, null, 2),
    );
  }
  mkdirSync(join(dir, ".changeset"));
  const config = JSON.parse(
    readFileSync(join(repoRoot, ".changeset/config.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(dir, ".changeset/config.json"),
    JSON.stringify({ ...config, fixed, ignore: [] }),
  );
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
  // Keep git away from the linked node_modules (Windows git cannot add a junction).
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}
const changeset = (dir: string) =>
  spawnSync(process.execPath, [join(repoRoot, "node_modules/@changesets/cli/bin.js"), "version"], {
    cwd: dir,
    encoding: "utf8",
  });
const addChangeset = (dir: string, file: string, body: string) =>
  writeFileSync(join(dir, ".changeset", `${file}.md`), body);
const version = (dir: string, name: string) =>
  (
    JSON.parse(readFileSync(join(dir, "packages", name, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

describe("changesets: integration (temp copy of the repo)", () => {
  it("a patch changeset moves the version by one patch and CHANGELOG.md gains exactly that sentence", () => {
    const dir = tempRepo({ gaugeline: "0.0.2" }, [["gaugeline"]]);
    addChangeset(
      dir,
      "fix-count",
      '---\n"gaugeline": patch\n---\n\nFixes a wrong count in the summary line.\n',
    );
    const r = changeset(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(version(dir, "gaugeline")).toBe("0.0.3");
    const log = readFileSync(join(dir, "packages/gaugeline/CHANGELOG.md"), "utf8");
    expect(log.match(/Fixes a wrong count in the summary line\./g)).toHaveLength(1);
    expect(parseChangelog(log)[0]).toMatchObject({
      version: "0.0.3",
      items: ["Fixes a wrong count in the summary line."],
    });
  }, 60_000);

  it("gaugeline and gaugeline-free end on the same version after a bump to only one of them", () => {
    const dir = tempRepo({ gaugeline: "0.1.0", "gaugeline-free": "0.1.0" }, [
      ["gaugeline", "gaugeline-free"],
    ]);
    addChangeset(dir, "minor", '---\n"gaugeline": minor\n---\n\nAdds the plan check.\n');
    expect(changeset(dir).status).toBe(0);
    expect([version(dir, "gaugeline"), version(dir, "gaugeline-free")]).toEqual(["0.2.0", "0.2.0"]);
  }, 60_000);
});

describe("changesets: edge cases", () => {
  it("no pending changesets: version exits 0 and changes nothing", () => {
    const dir = tempRepo({ gaugeline: "0.0.2" }, [["gaugeline"]]);
    const r = changeset(dir);
    expect(r.status).toBe(0);
    expect(version(dir, "gaugeline")).toBe("0.0.2");
  }, 60_000);

  it("a version with only (internal) changesets has items [] and the docs page skips it", () => {
    const entries = parseChangelog(
      "# gaugeline\n\n## 0.0.4\n\n### Patch Changes\n\n- (internal) Refactors the runner.\n",
    );
    expect(entries).toEqual([{ version: "0.0.4", headline: null, items: [] }]);
    expect(renderChangelogPage(entries.map((e) => ({ ...e, date: null })))).not.toContain("0.0.4");
  });

  it("a summary containing a pipe or an angle bracket is kept and escaped in the JSON, not dropped", () => {
    const [entry] = parseChangelog(
      "## 0.0.5\n\n### Patch Changes\n\n- Reads <link rel=canonical> | and keeps going.\n",
    );
    const json = JSON.stringify([entry]);
    expect((JSON.parse(json) as { items: string[] }[])[0]?.items).toEqual([
      "Reads <link rel=canonical> | and keeps going.",
    ]);
  });

  it("two pull requests merged in the same minute: one release, both sentences present", () => {
    const dir = tempRepo({ gaugeline: "0.0.2" }, [["gaugeline"]]);
    addChangeset(dir, "one", '---\n"gaugeline": patch\n---\n\nFirst change.\n');
    addChangeset(dir, "two", '---\n"gaugeline": patch\n---\n\nSecond change.\n');
    expect(changeset(dir).status).toBe(0);
    expect(version(dir, "gaugeline")).toBe("0.0.3");
    const [entry] = parseChangelog(
      readFileSync(join(dir, "packages/gaugeline/CHANGELOG.md"), "utf8"),
    );
    expect(entry?.items.sort()).toEqual(["First change.", "Second change."]);
  }, 60_000);
});
