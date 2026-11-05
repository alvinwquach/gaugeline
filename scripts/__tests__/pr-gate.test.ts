import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gate, isSource, parseChangeset } from "../lib/gate.js";
import { collectInput } from "../pr-gate.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const SRC = "packages/core/src/checks/noindex.ts";
const patch = { bump: "patch" as const, summary: "Reads the robots header too." };

describe("gate: unit", () => {
  it("source file, no changeset: not ok, one problem", () => {
    expect(gate({ files: [SRC], changesets: [], labels: [] })).toEqual({
      ok: false,
      problems: ["This changes source but has no changeset. Run pnpm changeset."],
    });
  });
  it("source file, patch changeset, docs file: ok", () => {
    expect(gate({ files: [SRC, "docs/checks.md"], changesets: [patch], labels: [] }).ok).toBe(true);
  });
  it("source file, patch changeset, no docs file: not ok", () => {
    expect(gate({ files: [SRC], changesets: [patch], labels: [] }).problems).toEqual([
      "This changes what users see but no docs page changed.",
    ]);
  });
  it('source file, empty changeset with "(internal) ..." summary, no docs file: ok', () => {
    expect(
      gate({
        files: [SRC],
        changesets: [{ bump: "none", summary: "(internal) Refactors the runner." }],
        labels: [],
      }).ok,
    ).toBe(true);
  });
  it("only a test file changed: ok with no changeset", () => {
    expect(
      gate({ files: ["packages/core/src/__tests__/x.test.ts"], changesets: [], labels: [] }).ok,
    ).toBe(true);
  });
  it("only docs changed: ok with no changeset", () => {
    expect(gate({ files: ["docs/options.md"], changesets: [], labels: [] }).ok).toBe(true);
  });
  it("label internal with source and nothing else: ok", () => {
    expect(gate({ files: [SRC], changesets: [], labels: ["internal"] }).ok).toBe(true);
  });
  it("a summary that is too short or has no full stop is named", () => {
    expect(
      gate({
        files: ["docs/a.md"],
        changesets: [{ file: ".changeset/x.md", bump: "none", summary: "(internal) wip" }],
        labels: [],
      }).problems,
    ).toEqual([
      ".changeset/x.md: the summary must be one full sentence of at least 12 characters ending with a full stop.",
    ]);
  });
  it("parses changeset front matter, taking the largest bump", () => {
    expect(
      parseChangeset(
        '---\n"gaugeline": minor\n"@gaugeline/core": patch\n---\n\nAdds the plan check.\n',
      ),
    ).toEqual({
      bump: "minor",
      summary: "Adds the plan check.",
    });
    expect(parseChangeset("---\n---\n\n(internal) Tidies up.\n")).toEqual({
      bump: "none",
      summary: "(internal) Tidies up.",
    });
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-gate-"));
  temps.push(dir);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], {
      cwd: dir,
      stdio: "pipe",
    });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git("init", "-q", "-b", "main");
  write("packages/core/src/a.ts", "export const a = 1;\n");
  write(".changeset/old-one.md", "---\n---\n\n(internal) An older change.\n");
  write("docs/options.md", "# Options\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-q", "-b", "feature");
  return { dir, git, write };
}
const runGate = (dir: string, env: Record<string, string> = {}) =>
  spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repoRoot, "scripts/pr-gate.ts"),
      "--base",
      "main",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: "", ...env },
    },
  );

describe("pr-gate wrapper: integration (temp git repo)", () => {
  it("finds the changed files against the merge base and exits 1 with the expected line on stderr", () => {
    const { dir, git, write } = repo();
    write("packages/core/src/a.ts", "export const a = 2;\n");
    git("commit", "-qam", "change source");
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      "pr-gate: This changes source but has no changeset. Run pnpm changeset.\n",
    );
  }, 30_000);

  it("labels come from GITHUB_EVENT_PATH", () => {
    const { dir, git, write } = repo();
    write("packages/core/src/a.ts", "export const a = 3;\n");
    git("commit", "-qam", "change source");
    write("../event.json", JSON.stringify({ pull_request: { labels: [{ name: "internal" }] } }));
    expect(runGate(dir, { GITHUB_EVENT_PATH: join(dir, "../event.json") }).status).toBe(0);
  }, 30_000);
});

describe("pr-gate: edge cases", () => {
  it("a source file that was only renamed counts as source changed", () => {
    const { dir, git } = repo();
    renameSync(join(dir, "packages/core/src/a.ts"), join(dir, "packages/core/src/b.ts"));
    git("add", "-A");
    git("commit", "-qm", "rename");
    const input = collectInput(dir, "main", undefined);
    expect(input.files).toEqual(
      expect.arrayContaining(["packages/core/src/a.ts", "packages/core/src/b.ts"]),
    );
    expect(gate(input).ok).toBe(false);
  }, 30_000);

  it("a changeset that was deleted and none added is a problem", () => {
    const { dir, git } = repo();
    git("rm", "-q", ".changeset/old-one.md");
    git("commit", "-qm", "delete changeset");
    const result = gate(collectInput(dir, "main", undefined));
    expect(result.problems).toEqual([
      "This deletes a changeset (.changeset/old-one.md) and adds none. Changesets are removed by the Release pull request.",
    ]);
  }, 30_000);

  it("tests under __tests__ and *.test.ts files are both treated as tests", () => {
    expect(isSource("packages/core/src/checks/__tests__/x.test.ts")).toBe(false);
    expect(isSource("packages/core/src/x.test.ts")).toBe(false);
    expect(isSource("packages/core/src/x.ts")).toBe(true);
    expect(isSource("packages/core/schema/result.v1.json")).toBe(false);
  });

  it("a docs change that is only the generated docs/changelog.data.json does not count", () => {
    expect(
      gate({ files: [SRC, "docs/changelog.data.json"], changesets: [patch], labels: [] }).ok,
    ).toBe(false);
  });

  it("GITHUB_EVENT_PATH missing (local run): labels is [] and the script still runs", () => {
    const { dir, git, write } = repo();
    write("docs/options.md", "# Options\n\nMore.\n");
    git("commit", "-qam", "docs only");
    const input = collectInput(dir, "main", undefined);
    expect(input.labels).toEqual([]);
    const r = runGate(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pr-gate: ok");
  }, 30_000);
});
