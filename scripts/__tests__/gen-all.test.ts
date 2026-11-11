import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENERATED_FILES, genSteps, parseGenAllArgs } from "../lib/gen-all.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("gen:all: unit", () => {
  it("runs the adapters first, then the checks, the skill (which reads the checks' data), the flags and the surface", () => {
    expect(genSteps({ surface: true }).map((s) => s.name)).toEqual([
      "gen:adapters",
      "gen:checks",
      "gen:skill",
      "docs:flags",
      "surface",
    ]);
  });

  it("--no-surface leaves the surface step out; --base reaches only the surface step", () => {
    expect(genSteps({ surface: false }).map((s) => s.name)).not.toContain("surface");
    const steps = genSteps({ surface: true, base: "FETCH_HEAD" });
    expect(steps.find((s) => s.name === "surface")?.args).toEqual(["--base", "FETCH_HEAD"]);
    expect(steps.filter((s) => s.args.includes("--base")).map((s) => s.name)).toEqual(["surface"]);
  });

  it("no step runs a generator in --check mode: a branch need not match the committed copy", () => {
    for (const s of genSteps({ surface: true, base: "x" })) expect(s.args).not.toContain("--check");
  });

  it("lists every generated file once, relative with forward slashes, all of them tracked today", () => {
    expect(new Set(GENERATED_FILES).size).toBe(GENERATED_FILES.length);
    for (const f of GENERATED_FILES) {
      expect(f).not.toMatch(/^[/.]|\\/);
      expect(existsSync(join(repoRoot, f)), f).toBe(true);
    }
    // The files the owner named on 11 Nov 2026.
    expect(GENERATED_FILES).toEqual(
      expect.arrayContaining([
        "README.md",
        "packages/cli/README.md",
        "docs/integrations/index.md",
        "docs/checks.data.json",
        "docs/check-ids.lock.json",
        "docs/options.md",
        "packages/app/src/check-titles.ts",
        "skills/gaugeline/SKILL.md",
        "skills/gaugeline/references/findings.md",
        "public-surface.lock.json",
      ]),
    );
  });

  it("never lists a hand-written file: nav.ts and the two test lists stay in the branch that edits them", () => {
    for (const f of [
      "docs/nav.ts",
      "packages/core/src/checks/__tests__/runner.test.ts",
      "packages/cli/src/__tests__/all-checks-fire.test.ts",
      "packages/core/src/checks/index.ts",
    ])
      expect(GENERATED_FILES).not.toContain(f);
  });

  it("parses the arguments", () => {
    expect(parseGenAllArgs([])).toEqual({ kind: "run", opts: { surface: true } });
    expect(parseGenAllArgs(["--no-surface"])).toEqual({ kind: "run", opts: { surface: false } });
    expect(parseGenAllArgs(["--base", "FETCH_HEAD"])).toEqual({
      kind: "run",
      opts: { surface: true, base: "FETCH_HEAD" },
    });
    expect(parseGenAllArgs(["--restore"])).toEqual({ kind: "restore", ref: "origin/main" });
    expect(parseGenAllArgs(["--restore", "HEAD"])).toEqual({ kind: "restore", ref: "HEAD" });
  });

  it("refuses an unknown flag, a --base with no value and --restore together with --base", () => {
    for (const argv of [["--fix"], ["--base"], ["--restore", "--base", "x"]])
      expect(parseGenAllArgs(argv).kind, argv.join(" ")).toBe("error");
  });
});

/**
 * Integration: a temp git repository holding the parts of the workspace the generators touch, with the real
 * node_modules linked. gen:all must write only files on the list, and writing twice must change nothing.
 */
let temp = "";
beforeAll(() => {
  // The long path: on Windows, tmpdir() can be an 8.3 short name that Vite resolves differently.
  temp = realpathSync.native(mkdtempSync(join(tmpdir(), "gaugeline-genall-")));
  const copy = (p: string) =>
    cpSync(join(repoRoot, p), join(temp, p), {
      recursive: true,
      filter: (src) => !/[\\/](dist|node_modules|\.vitepress)([\\/]|$)/.test(src),
    });
  for (const p of [
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "tsconfig.json",
    ".prettierrc.json",
    ".prettierignore",
    ".gitattributes",
    ".changeset",
    "scripts",
    "packages/core",
    "packages/cli/package.json",
    "packages/cli/src",
    "packages/cli/README.md",
    "packages/app/src/check-titles.ts",
    "docs/adapter-pages.generated.ts",
    "docs/check-ids.lock.json",
    "docs/checks.data.json",
    "docs/integrations/index.md",
    "docs/options.md",
    "skills",
    "README.md",
    "public-surface.lock.json",
  ]) {
    mkdirSync(join(temp, p, ".."), { recursive: true });
    copy(p);
  }
  writeFileSync(join(temp, ".gitignore"), "node_modules/\ndist/\n");
  symlinkSync(join(repoRoot, "node_modules"), join(temp, "node_modules"), "junction");
  for (const pkg of ["core", "cli"])
    symlinkSync(
      join(repoRoot, `packages/${pkg}/node_modules`),
      join(temp, `packages/${pkg}/node_modules`),
      "junction",
    );
  git("init", "-q", "-b", "main");
}, 120_000);
afterAll(
  () => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  120_000,
);

function git(...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: temp,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
const genAll = (...args: string[]) =>
  spawnSync(
    process.execPath,
    [join(temp, "node_modules/tsx/dist/cli.mjs"), join(temp, "scripts/gen-all.ts"), ...args],
    {
      cwd: temp,
      encoding: "utf8",
      // pnpm's own variables make a child npm warn; nothing here needs them.
      env: { ...process.env, INIT_CWD: "" },
    },
  );
const changed = () =>
  git("status", "--porcelain", "-z")
    .split("\0")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .sort();

describe("gen:all: integration (temp git repository)", () => {
  it("writes only listed files, then a second run changes nothing", () => {
    // Break the generated files the way a merged pull request leaves them: stale, or never regenerated.
    git("add", "-A");
    git("commit", "-q", "-m", "copy");
    rmSync(join(temp, "docs/checks.data.json"));
    writeFileSync(join(temp, "packages/app/src/check-titles.ts"), "// stale\n");
    writeFileSync(join(temp, "docs/check-ids.lock.json"), "[]\n");
    writeFileSync(
      join(temp, "docs/options.md"),
      readFileSync(join(temp, "docs/options.md"), "utf8").replace("--allow-private", "--allow-pvt"),
    );
    // Generate against a base that is the repository's own first commit (what a pull request's base is).
    const first = genAll("--base", "HEAD");
    // The lock was emptied, which is fine: ids are only ever added there. The run must still succeed.
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const files = changed();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(GENERATED_FILES, f).toContain(f);
    git("add", "-A");
    git("commit", "-q", "-m", "regenerated");
    const second = genAll("--base", "HEAD");
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(changed()).toEqual([]);
  }, 240_000);

  it("--restore puts a generated file back to what a commit holds and touches nothing else", () => {
    const file = join(temp, "docs/options.md");
    const hand = join(temp, "docs/nav.ts");
    writeFileSync(file, "junk\n");
    mkdirSync(join(temp, "docs"), { recursive: true });
    writeFileSync(hand, "// my edit\n");
    const r = genAll("--restore", "HEAD");
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).not.toBe("junk\n");
    expect(readFileSync(hand, "utf8")).toBe("// my edit\n");
  }, 60_000);

  it("a failing generator fails the run, names it, and the rest still run", () => {
    writeFileSync(join(temp, "docs/integrations/index.md"), "no markers here\n");
    const r = genAll("--no-surface");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("gen:adapters failed");
    // docs:flags ran after the failed step.
    expect(r.stdout + r.stderr).toContain("docs:flags");
  }, 120_000);
});
