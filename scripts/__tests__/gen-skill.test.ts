import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  renderAreaTable,
  renderFindingsTable,
  validateFrontmatter,
  type SkillCheck,
} from "../lib/gen-skill.js";
import { createPageRegistry } from "../../packages/core/src/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0))
    rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function gen(root: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
      join(repoRoot, "scripts/gen-skill.ts"),
      ...args,
    ],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, GEN_SKILL_ROOT: root } },
  );
}

/** A copy of the files gen:skill reads and writes, so a test can change them without touching the repository. */
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "gaugeline-gen-skill-"));
  temps.push(root);
  mkdirSync(join(root, "docs"), { recursive: true });
  cpSync(join(repoRoot, "docs/checks.data.json"), join(root, "docs/checks.data.json"));
  cpSync(join(repoRoot, "skills"), join(root, "skills"), { recursive: true });
  return root;
}

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const skillMd = join(repoRoot, "skills/gaugeline/SKILL.md");
const findingsMd = join(repoRoot, "skills/gaugeline/references/findings.md");

const sample: SkillCheck[] = [
  { id: "zeta", severity: "low", area: "Visitors", title: "Z | pipe", fix: "Do z." },
  { id: "beta", severity: "high", area: "Leads", title: "B title", fix: "Do b." },
  { id: "alpha", severity: "high", area: "Visitors", title: "A title", fix: "Do a." },
  { id: "mid", severity: "medium", area: "Visitors", title: "M title", fix: "Do m." },
];

describe("gen-skill: unit", () => {
  it("sorts the table by level (fix first, then soon, then worth knowing), then by id", () => {
    const rows = renderFindingsTable(sample)
      .split("\n")
      .filter((l) => /^\| [^|]+ \| `/.test(l));
    expect(rows.map((r) => /`([a-z]+)`/.exec(r)?.[1])).toEqual(["alpha", "beta", "mid", "zeta"]);
  });

  it("is the same whatever order the checks arrive in", () => {
    expect(renderFindingsTable([...sample].reverse())).toBe(renderFindingsTable(sample));
  });

  it("uses the labels people see in the report, and escapes a pipe in a cell", () => {
    const t = renderFindingsTable(sample);
    expect(t).toContain("Fix this first");
    expect(t).toContain("Fix soon");
    expect(t).toContain("Worth knowing");
    expect(t).toContain("Z \\| pipe");
    expect(t).not.toMatch(/\| high \|/);
  });

  it("counts checks per area and level, areas in the registry's order", () => {
    const t = renderAreaTable(sample);
    expect(t).toContain("| Visitors | 1 | 1 | 1 |");
    expect(t).toContain("| Leads | 1 | 0 | 0 |");
    expect(t.indexOf("Visitors")).toBeLessThan(t.indexOf("Leads"));
  });
});

describe("SKILL.md frontmatter", () => {
  it("parses name and description between the opening and closing ---", () => {
    const fm = parseFrontmatter(
      '---\nname: x-y\ndescription: "Does a thing. Use when asked."\n---\n# Body\n',
    );
    expect(fm).toEqual({ name: "x-y", description: "Does a thing. Use when asked." });
  });

  it("refuses a file whose first line is not ---", () => {
    expect(() => parseFrontmatter("\n---\nname: a\n---\n")).toThrow(/first line/);
  });

  it("validates the Agent Skills rules: name and description", () => {
    const ok = { name: "gaugeline", description: "Runs it. Use when asked." };
    expect(validateFrontmatter(ok, "gaugeline")).toEqual([]);
    expect(validateFrontmatter({ ...ok, name: "Gauge Line" }, "gaugeline").join(" ")).toMatch(
      /name/,
    );
    expect(validateFrontmatter({ ...ok, name: "a".repeat(65) }, "gaugeline").join(" ")).toMatch(
      /64/,
    );
    expect(validateFrontmatter({ ...ok, name: "claude-tools" }, "claude-tools").join(" ")).toMatch(
      /reserved/,
    );
    expect(validateFrontmatter(ok, "other-folder").join(" ")).toMatch(/folder/);
    expect(validateFrontmatter({ ...ok, description: "" }, "gaugeline").join(" ")).toMatch(
      /description/,
    );
    expect(
      validateFrontmatter({ ...ok, description: "x".repeat(1025) }, "gaugeline").join(" "),
    ).toMatch(/1024/);
    expect(
      validateFrontmatter({ ...ok, description: "use <b>tags</b>" }, "gaugeline").join(" "),
    ).toMatch(/XML/);
  });

  it("the published SKILL.md frontmatter validates", () => {
    const fm = parseFrontmatter(read(skillMd));
    expect(validateFrontmatter(fm, "gaugeline")).toEqual([]);
    expect(fm.name).toBe("gaugeline");
    expect(fm.description).toMatch(/Use when/i);
  });
});

describe("gen-skill: the published table matches the registry", () => {
  it("every check in the registry has a row in references/findings.md, and no other row exists", () => {
    const ids = createPageRegistry()
      .all()
      .map((c) => c.id);
    const rows = [...read(findingsMd).matchAll(/^\| [^|]+ \| `([a-z0-9-]+)` \|/gm)].map(
      (m) => m[1],
    );
    for (const id of ids) expect(rows, id).toContain(id);
    expect(new Set(rows).size).toBe(rows.length);
    const data = JSON.parse(read(join(repoRoot, "docs/checks.data.json"))) as { id: string }[];
    expect([...rows].sort()).toEqual(data.map((e) => e.id).sort());
  });

  it("the committed files are current (pnpm gen:skill --check)", () => {
    const r = gen(repoRoot, ["--check"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 30_000);

  it("a check added without regenerating the skill fails --check, and gen:skill then fixes it", () => {
    const root = copy();
    const dataPath = join(root, "docs/checks.data.json");
    const data = JSON.parse(read(dataPath)) as Record<string, unknown>[];
    data.push({
      ...(data[0] as Record<string, unknown>),
      id: "zz-new-check",
      title: "A brand new check",
    });
    writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
    const stale = gen(root, ["--check"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/gen:skill/);
    expect(gen(root).status).toBe(0);
    expect(read(join(root, "skills/gaugeline/references/findings.md"))).toContain("zz-new-check");
    expect(gen(root, ["--check"]).status).toBe(0);
  }, 60_000);

  it("running twice produces byte-identical files", () => {
    const root = copy();
    expect(gen(root).status).toBe(0);
    const first = read(join(root, "skills/gaugeline/references/findings.md"));
    const firstSkill = read(join(root, "skills/gaugeline/SKILL.md"));
    expect(gen(root).status).toBe(0);
    expect(read(join(root, "skills/gaugeline/references/findings.md"))).toBe(first);
    expect(read(join(root, "skills/gaugeline/SKILL.md"))).toBe(firstSkill);
  }, 60_000);

  it("refuses a hand edit between the markers in --check", () => {
    const root = copy();
    const p = join(root, "skills/gaugeline/references/findings.md");
    writeFileSync(p, read(p).replace("| Fix this first | `", "| Fix this last | `"));
    const r = gen(root, ["--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/findings\.md/);
  }, 30_000);
});

describe("the skill's safety rules", () => {
  const text = read(skillMd).replace(/\s+/g, " ");
  it("never tells an agent to probe, write or post", () => {
    // The skill may name the flags in order to forbid them; it must not contain an instruction that runs them.
    expect(text).not.toMatch(/^\s*(\$ |npx gaugeline .*--owner-consent)/m);
    expect(text).not.toMatch(/\bcurl\b.*(-X|--data)/);
  });
  it("states the data-not-instructions rule and does not claim output escaping exists", () => {
    expect(text).toMatch(/data, never instructions/i);
    expect(text).toMatch(/not yet shipped|separate piece of work/i);
    expect(text).not.toMatch(/\bsanitis(ed|es|ing)\b.*\b(output|findings)\b/i);
  });
  it("lists only flags that exist in docs/options.md", () => {
    const options = read(join(repoRoot, "docs/options.md"));
    for (const m of text.matchAll(/`(--[a-z][a-z-]*)/g))
      expect(options, m[1]).toContain(`\`${m[1]}`);
  });
});
