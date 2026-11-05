import type { PublicSurface } from "../../packages/core/src/index.js";

export type Bump = "none" | "patch" | "minor" | "major";
const RANK: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

/** Every public item as a key: "--flag", "check:<id>", "env:NAME", "exit:<n>", "schema:<n>". */
export function surfaceKeys(s: PublicSurface): Set<string> {
  return new Set([
    ...Object.values(s.flags)
      .flat()
      .map((f) => `--${f}`),
    ...s.checkIds.map((id) => `check:${id}`),
    ...s.envVars.map((v) => `env:${v}`),
    ...s.exitCodes.map((c) => `exit:${c}`),
    `schema:${s.jsonSchema}`,
  ]);
}

export function diffSurface(
  before: PublicSurface,
  after: PublicSurface,
): { removed: string[]; added: string[]; severityChanged: string[] } {
  const b = surfaceKeys(before);
  const a = surfaceKeys(after);
  return {
    removed: [...b].filter((k) => !a.has(k)).sort(),
    added: [...a].filter((k) => !b.has(k)).sort(),
    severityChanged: Object.keys(after.severities)
      .filter(
        (id) =>
          before.severities[id] !== undefined && before.severities[id] !== after.severities[id],
      )
      .sort(),
  };
}

function versionAtLeast(version: string, target: string): boolean {
  const p = (v: string) =>
    v
      .split(/[.-]/)
      .slice(0, 3)
      .map((x) => Number.parseInt(x, 10) || 0);
  const [a, b] = [p(version), p(target)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

export interface SurfaceCheckInput {
  before: PublicSurface;
  after: PublicSurface;
  /** The largest pending changeset bump for gaugeline (or, with none left, the version bump). */
  bump: Bump;
  /** Changeset summaries, to find the changelog line for a severity change. */
  summaries: string[];
  version: string;
  deprecated: ReadonlyMap<string, { since: string; removeIn: string }>;
}

/** The semver rules from STABILITY.md, applied to what changed in the public surface. */
export function checkSurface(input: SurfaceCheckInput): {
  ok: boolean;
  problems: string[];
  notes: string[];
} {
  const { removed, added, severityChanged } = diffSurface(input.before, input.after);
  const problems: string[] = [];
  const notes: string[] = [];
  const pre1 = input.version.startsWith("0.");
  const needed = (level: Bump): boolean => {
    if (RANK[input.bump] >= RANK[level]) return true;
    if (level === "major" && pre1 && RANK[input.bump] >= RANK.minor) {
      if (!notes.includes("pre-1.0 rule applied: a minor bump stands in for major.")) {
        notes.push("pre-1.0 rule applied: a minor bump stands in for major.");
      }
      return true;
    }
    return false;
  };
  for (const key of removed) {
    if (key.startsWith("schema:")) continue;
    const d = input.deprecated.get(key);
    if (!d)
      problems.push(
        `${key} was removed without being deprecated first (add it to DEPRECATED; see STABILITY.md).`,
      );
    else if (!versionAtLeast(input.version, d.removeIn))
      problems.push(
        `${key} is deprecated but not yet removable: removeIn is ${d.removeIn}, this is ${input.version}.`,
      );
    else if (!needed("major"))
      problems.push(
        `${key} was removed: that needs a major changeset (minor before 1.0), not ${input.bump}.`,
      );
  }
  if (input.before.jsonSchema !== input.after.jsonSchema && !needed("major")) {
    problems.push(
      `The JSON schema number changed from ${input.before.jsonSchema} to ${input.after.jsonSchema}: that needs a major changeset.`,
    );
  }
  for (const key of added) {
    if (key.startsWith("schema:")) continue;
    if (!needed("minor"))
      problems.push(`${key} was added: that needs a minor changeset, not ${input.bump}.`);
  }
  for (const id of severityChanged) {
    const from = input.before.severities[id];
    const to = input.after.severities[id];
    if (!needed("minor"))
      problems.push(
        `check:${id} changed severity (${from} to ${to}): that needs a minor changeset.`,
      );
    if (!input.summaries.some((s) => s.includes(id))) {
      problems.push(
        `check:${id} changed severity (${from} to ${to}): add a changelog line that names ${id}.`,
      );
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

/** Bump between two versions, for the Release pull request (no changesets left). */
export function bumpBetween(from: string, to: string): Bump {
  const p = (v: string) => v.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const [a, b] = [p(from), p(to)];
  if ((b[0] ?? 0) > (a[0] ?? 0)) return "major";
  if ((b[1] ?? 0) > (a[1] ?? 0)) return "minor";
  if ((b[2] ?? 0) > (a[2] ?? 0)) return "patch";
  return "none";
}
