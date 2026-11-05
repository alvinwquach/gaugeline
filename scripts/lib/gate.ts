export type Bump = "none" | "patch" | "minor" | "major";

export interface GateInput {
  /** Every changed path (both sides of a rename). */
  files: string[];
  /** Changesets added by this pull request. */
  changesets: { file?: string; bump: Bump; summary: string }[];
  labels: string[];
  /** Changeset files this pull request deletes. */
  deletedChangesets?: string[];
}

export interface GateResult {
  ok: boolean;
  problems: string[];
}

/** Generated files that do not count as a docs change. */
const GENERATED_DOCS = new Set(["docs/changelog.data.json", "docs/changelog.md"]);

export function isSource(path: string): boolean {
  return (
    /^packages\/[^/]+\/src\//.test(path) &&
    !/(^|\/)__tests__\//.test(path) &&
    !/\.test\.ts$/.test(path)
  );
}

export function isDocsChange(path: string): boolean {
  return path.startsWith("docs/") && !GENERATED_DOCS.has(path);
}

/** Written only by `changeset version` (pnpm version). */
export const RELEASE_CHANGELOG = "packages/cli/CHANGELOG.md";

export function isUserFacing(c: GateInput["changesets"][number]): boolean {
  return c.bump !== "none" && !c.summary.trim().startsWith("(internal)");
}

/** The pull request gate. Rules run in order; the internal label skips everything. */
export function gate(input: GateInput): GateResult {
  if (input.labels.includes("internal")) return { ok: true, problems: [] };
  const problems: string[] = [];
  const sourceChanged = input.files.some(isSource);
  if (sourceChanged && input.changesets.length === 0) {
    problems.push("This changes source but has no changeset. Run pnpm changeset.");
  }
  // The Release pull request deletes every changeset; `changeset version` is the only thing that
  // writes the CLI's CHANGELOG.md, so a pull request that changes it is the release.
  const isRelease = input.files.includes(RELEASE_CHANGELOG);
  if (!isRelease && (input.deletedChangesets ?? []).length > 0 && input.changesets.length === 0) {
    problems.push(
      `This deletes a changeset (${(input.deletedChangesets ?? []).join(", ")}) and adds none. Changesets are removed by the Release pull request.`,
    );
  }
  if (input.changesets.some(isUserFacing) && !input.files.some(isDocsChange)) {
    problems.push("This changes what users see but no docs page changed.");
  }
  for (const c of input.changesets) {
    const s = c.summary.trim();
    if (s.length < 12 || !s.endsWith(".")) {
      problems.push(
        `${c.file ?? "A changeset"}: the summary must be one full sentence of at least 12 characters ending with a full stop.`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Parse a changeset file: front matter of `"pkg": bump` lines, then the summary. */
export function parseChangeset(text: string): { bump: Bump; summary: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/.exec(text.trimStart());
  if (!m) return { bump: "none", summary: text.trim() };
  const order: Bump[] = ["none", "patch", "minor", "major"];
  let bump: Bump = "none";
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const b = /:\s*(patch|minor|major)\s*$/.exec(line)?.[1] as Bump | undefined;
    if (b && order.indexOf(b) > order.indexOf(bump)) bump = b;
  }
  return { bump, summary: (m[2] ?? "").trim() };
}
