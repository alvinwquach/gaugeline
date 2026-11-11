/**
 * The generated parts of the agent skill (skills/gaugeline): the table of what each finding means and the
 * usual fix, and the count of checks per area. They are rendered from docs/checks.data.json, which
 * `pnpm gen:checks` renders from the check registry (and `gen:checks --check` keeps current), so the skill
 * cannot drift from the checks. Pure functions here; scripts/gen-skill.ts reads and writes the files.
 */
import { AREAS, SEVERITIES, SEVERITY_LABEL, type Severity } from "../../packages/core/src/model.js";

/** The fields of a checks.data.json entry the skill uses. */
export interface SkillCheck {
  id: string;
  severity: Severity;
  area: string;
  title: string;
  fix: string;
}

const cell = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

/** Fix first, then fix soon, then worth knowing; ids in alphabetical order inside a level. */
function sorted(checks: readonly SkillCheck[]): SkillCheck[] {
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  return [...checks].sort(
    (a, b) => rank(a.severity) - rank(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** One row per check: the level people see in the report, the id, what it means, the usual fix. */
export function renderFindingsTable(checks: readonly SkillCheck[]): string {
  return [
    "| Level | Check id | What it means | Usual fix |",
    "| --- | --- | --- | --- |",
    ...sorted(checks).map(
      (c) => `| ${SEVERITY_LABEL[c.severity]} | \`${c.id}\` | ${cell(c.title)} | ${cell(c.fix)} |`,
    ),
  ].join("\n");
}

/** How many checks each area has at each level, areas in the registry's order. */
export function renderAreaTable(checks: readonly SkillCheck[]): string {
  const areas = [
    ...AREAS,
    ...new Set(checks.map((c) => c.area).filter((a) => !AREAS.includes(a as never))),
  ];
  const rows = areas
    .map((area) => {
      const inArea = checks.filter((c) => c.area === area);
      const counts = SEVERITIES.map((s) => inArea.filter((c) => c.severity === s).length);
      return { area, counts, total: inArea.length };
    })
    .filter((r) => r.total > 0)
    .map((r) => `| ${cell(r.area)} | ${r.counts.join(" | ")} |`);
  return [
    `| Area | ${SEVERITIES.map((s) => SEVERITY_LABEL[s]).join(" | ")} |`,
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

/**
 * The frontmatter of a SKILL.md: single-line `key: value` pairs between the opening --- (which must be the
 * file's first line) and the closing ---. Values may be quoted. Nothing else is read: this is not a YAML parser.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("The opening --- must be the file's first line.");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("The frontmatter has no closing ---.");
  const out: Frontmatter = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!m) throw new Error(`Frontmatter line is not "key: value": ${line}`);
    const raw = (m[2] ?? "").trim();
    out[m[1] ?? ""] = /^(".*"|'.*')$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return out;
}

/**
 * The Agent Skills rules for the two required fields (platform.claude.com/docs/en/agents-and-tools/agent-skills/overview):
 * name up to 64 characters of lowercase letters, numbers and hyphens, no XML tags, not containing "anthropic" or
 * "claude"; description non-empty, up to 1,024 characters, no XML tags. The name matches its folder
 * (agentskills.io; not read in this build, so that rule is uncited). Returns the problems, empty when valid.
 */
export function validateFrontmatter(fm: Frontmatter, folder: string): string[] {
  const problems: string[] = [];
  const { name, description } = fm;
  if (!name) problems.push("name is required");
  else {
    if (name.length > 64) problems.push("name is longer than 64 characters");
    if (!/^[a-z0-9-]+$/.test(name))
      problems.push("name may contain only lowercase letters, numbers and hyphens");
    if (/<[^>]*>/.test(name)) problems.push("name cannot contain XML tags");
    if (/anthropic|claude/.test(name))
      problems.push('name cannot contain the reserved words "anthropic" or "claude"');
    if (name !== folder) problems.push(`name "${name}" must match its folder "${folder}"`);
  }
  if (!description) problems.push("description is required and must not be empty");
  else {
    if (description.length > 1024) problems.push("description is longer than 1024 characters");
    if (/<[^>]*>/.test(description)) problems.push("description cannot contain XML tags");
  }
  return problems;
}
