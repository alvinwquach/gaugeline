import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { places, planNewCheck, registeredIds, type RepoState } from "../lib/new-check.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const indexSource = readFileSync(join(repoRoot, "packages/core/src/checks/index.ts"), "utf8");
const state = (over: Partial<RepoState> = {}): RepoState => ({
  registered: registeredIds(indexSource),
  locked: JSON.parse(readFileSync(join(repoRoot, "docs/check-ids.lock.json"), "utf8")) as string[],
  files: new Set(),
  indexSource,
  ...over,
});
const opts = {
  id: "demo-check",
  area: "search",
  severity: "low",
  title: "The demo check says hello",
};

describe("planNewCheck: unit (no disk)", () => {
  it("a valid id plans the six places: check, test, fixture folder, registration, changeset, lock entry", () => {
    const plan = planNewCheck(opts, state());
    expect(places(plan)).toEqual([
      "packages/core/src/checks/demo-check.ts",
      "packages/core/src/checks/__tests__/demo-check.test.ts",
      "packages/fixtures/sites/demo-check/",
      "packages/core/src/checks/index.ts",
      ".changeset/demo-check.md",
      "docs/check-ids.lock.json",
    ]);
    expect(plan.map((s) => s.path)).toContain("packages/fixtures/sites/demo-check/routes.json");
  });

  it("the check file contains the id, the mapped Area name and the severity", () => {
    const check = planNewCheck(opts, state())[0]?.content ?? "";
    expect(check).toContain('id: "demo-check"');
    expect(check).toContain('area: "Search & sharing"');
    expect(check).toContain('severity: "low"');
    expect(check).toMatch(/what: "TODO/);
  });

  it("the index.ts update keeps registrations sorted by id", () => {
    const index =
      planNewCheck({ ...opts, id: "aaa-first" }, state()).find((s) => s.path.endsWith("index.ts"))
        ?.content ?? "";
    const ids = registeredIds(index);
    expect(ids[0]).toBe("aaa-first");
    expect(ids).toEqual([...ids].sort());
    expect(index).toContain("  aaaFirst,");
  });

  it("the changeset is a minor bump with the title in the summary", () => {
    const cs = planNewCheck(opts, state()).find((s) => s.path.startsWith(".changeset/"))?.content;
    expect(cs).toBe('---\n"gaugeline": minor\n---\n\nNew check: The demo check says hello.\n');
  });

  it('an id that is not kebab-case ("Canonical_Elsewhere") throws before planning', () => {
    expect(() => planNewCheck({ ...opts, id: "Canonical_Elsewhere" }, state())).toThrow(
      /kebab-case/,
    );
  });

  it("an unknown area or severity throws and lists the allowed values", () => {
    expect(() => planNewCheck({ ...opts, area: "seo" }, state())).toThrow(
      "search, visitors, sales, leads, security, launch",
    );
    expect(() => planNewCheck({ ...opts, severity: "urgent" }, state())).toThrow(
      "high, medium, low",
    );
  });
});

describe("planNewCheck: edge cases", () => {
  it("an id in check-ids.lock.json but not in the registry (a retired check) is refused", () => {
    expect(() =>
      planNewCheck({ ...opts, id: "retired-check" }, state({ locked: ["retired-check"] })),
    ).toThrow(/never reused/);
  });

  it("an id that is a prefix of another is allowed and its files do not collide", () => {
    const plan = planNewCheck({ ...opts, id: "canonical" }, state());
    expect(plan[0]?.path).toBe("packages/core/src/checks/canonical.ts");
    const ids = registeredIds(plan.find((s) => s.path.endsWith("index.ts"))?.content ?? "");
    expect(ids.slice(0, 2)).toEqual(["canonical", "canonical-elsewhere"]);
  });

  it("a title containing a double quote is escaped in the generated TypeScript", () => {
    const check =
      planNewCheck({ ...opts, title: 'The "Buy" button is hidden' }, state())[0]?.content ?? "";
    expect(check).toContain('title: "The \\"Buy\\" button is hidden"');
  });
});

/** A temp copy of the parts of the workspace the generator touches, with the real node_modules linked. */
let temp = "";
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "gaugeline-newcheck-"));
  const copy = (p: string) =>
    cpSync(join(repoRoot, p), join(temp, p), {
      recursive: true,
      filter: (src) => !/[\\/](dist|node_modules)([\\/]|$)/.test(src),
    });
  for (const p of [
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.ts",
    "scripts",
    "packages/core",
    "packages/fixtures",
    "docs/check-ids.lock.json",
    "docs/checks.data.json",
    ".changeset/config.json",
  ])
    copy(p);
  symlinkSync(join(repoRoot, "node_modules"), join(temp, "node_modules"), "junction");
  symlinkSync(
    join(repoRoot, "packages/core/node_modules"),
    join(temp, "packages/core/node_modules"),
    "junction",
  );
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const node = (args: string[], cwd = temp) =>
  spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: "" },
  });
const tsx = (script: string, args: string[], cwd = temp) =>
  node([join(temp, "node_modules/tsx/dist/cli.mjs"), join(temp, script), ...args], cwd);

describe("new:check: e2e and integration (temp copy of the repo)", () => {
  it("pnpm new:check demo-check --area search --severity low prints six paths and the Next line, exit 0", () => {
    const r = tsx("scripts/new-check.ts", ["demo-check", "--area", "search", "--severity", "low"]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe("Next: fill in the TODO text, then pnpm gen:checks");
  }, 60_000);

  it("applyPlan then vitest on the new test file: both scaffolded tests pass", () => {
    const r = node([
      join(temp, "node_modules/vitest/vitest.mjs"),
      "run",
      "packages/core/src/checks/__tests__/demo-check.test.ts",
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/2 passed/);
  }, 120_000);

  it("applyPlan then typecheck passes", () => {
    const r = node([
      join(temp, "node_modules/typescript/bin/tsc"),
      "-p",
      "packages/core/tsconfig.json",
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120_000);

  it("applyPlan then gen-checks fails, naming the id and TODO", () => {
    const r = tsx("scripts/gen-checks.ts", []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("demo-check (title)");
    expect(r.stderr).toContain("TODO");
  }, 60_000);

  it("running the generator twice with the same id: the second run exits 1 and writes nothing", () => {
    const before = readdirSync(join(temp, ".changeset")).sort();
    const r = tsx("scripts/new-check.ts", ["demo-check", "--area", "search", "--severity", "low"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('A check with the id "demo-check" already exists.');
    expect(readdirSync(join(temp, ".changeset")).sort()).toEqual(before);
  }, 60_000);

  it("run from a subdirectory of the repo: paths still resolve from the workspace root", () => {
    const r = tsx(
      "scripts/new-check.ts",
      ["sub-dir-check", "--area", "visitors", "--severity", "medium"],
      join(temp, "packages/core/src"),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(temp, "packages/core/src/checks/sub-dir-check.ts"))).toBe(true);
    expect(existsSync(join(temp, "packages/core/src/packages"))).toBe(false);
  }, 60_000);
});
