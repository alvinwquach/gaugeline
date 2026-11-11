/**
 * `pnpm gen:all`: every generator, in the order that works. Branches do not commit what these write (see
 * CONTRIBUTING.md, "Generated files"): a pull request's CI runs this into its own checkout, and one job on
 * main (.github/workflows/regenerate.yml) commits the result after each merge.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Every file a generator writes, relative to the repository root. The job on main commits only these, and
 * `--restore` puts only these back. Whole files that a script owns come first; then the files that are partly
 * hand-written and carry a generated block between markers (README tables, the options table, the skill).
 */
export const GENERATED_FILES: readonly string[] = [
  // gen:checks
  "docs/checks.data.json",
  "docs/check-ids.lock.json",
  "packages/app/src/check-titles.ts",
  "README.md",
  "packages/cli/README.md",
  // gen:adapters
  "packages/core/src/adapters/entries.generated.ts",
  "packages/core/src/adapters/__tests__/contracts.generated.ts",
  "docs/adapter-pages.generated.ts",
  "docs/integrations/index.md",
  // gen:skill
  "skills/gaugeline/SKILL.md",
  "skills/gaugeline/references/findings.md",
  // docs:flags
  "docs/options.md",
  // surface
  "public-surface.lock.json",
];

export interface GenAllOptions {
  /** False for jobs that build and test only; the surface rules run once, in the lint job. */
  surface: boolean;
  /** The ref whose public-surface.lock.json the surface rules compare with (a pull request's base). */
  base?: string;
}

export interface GenStep {
  name: string;
  script: string;
  args: string[];
}

/** Adapters first: the checks script loads the core, which loads the adapters' generated index. */
export function genSteps(opts: GenAllOptions): GenStep[] {
  return [
    { name: "gen:adapters", script: "scripts/gen-adapters.ts", args: [] },
    { name: "gen:checks", script: "scripts/gen-checks.ts", args: [] },
    { name: "gen:skill", script: "scripts/gen-skill.ts", args: [] },
    { name: "docs:flags", script: "scripts/build-docs.ts", args: [] },
    ...(opts.surface
      ? [
          {
            name: "surface",
            script: "scripts/check-surface.ts",
            args: opts.base ? ["--base", opts.base] : [],
          },
        ]
      : []),
  ];
}

export type GenAllCommand =
  | { kind: "run"; opts: GenAllOptions }
  | { kind: "restore"; ref: string }
  | { kind: "error"; message: string };

export function parseGenAllArgs(argv: string[]): GenAllCommand {
  const opts: GenAllOptions = { surface: true };
  let restore: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--no-surface") opts.surface = false;
    else if (a === "--base") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        return { kind: "error", message: "--base needs a git ref." };
      opts.base = v;
    } else if (a === "--restore") {
      const next = argv[i + 1];
      restore = next !== undefined && !next.startsWith("--") ? argv[++i] : "origin/main";
    } else return { kind: "error", message: `Unknown argument ${a}.` };
  }
  if (restore !== undefined) {
    if (opts.base !== undefined || !opts.surface)
      return { kind: "error", message: "--restore takes no other flag, only an optional git ref." };
    return { kind: "restore", ref: restore };
  }
  return { kind: "run", opts };
}

/** Runs each generator with the repository's own tsx. Every step runs; the code is 1 if any failed. */
export function runGenAll(root: string, opts: GenAllOptions): number {
  const failed: string[] = [];
  for (const step of genSteps(opts)) {
    process.stdout.write(`gen:all: ${step.name}\n`);
    // The same as `tsx <script>`, without needing pnpm or a shell (Windows too).
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(root, step.script), ...step.args],
      { cwd: root, stdio: "inherit" },
    );
    if (r.status !== 0) failed.push(step.name);
  }
  if (failed.length > 0) {
    process.stderr.write(
      `gen:all: ${failed.join(", ")} failed. Generation did not complete, so nothing here is safe to commit.\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * Puts the generated files back to what `ref` holds (index and working tree), so a branch commits none of
 * them. Hand-written files are never touched.
 */
export function restoreGenerated(root: string, ref: string): number {
  const r = spawnSync(
    "git",
    ["restore", `--source=${ref}`, "--staged", "--worktree", "--", ...GENERATED_FILES],
    { cwd: root, stdio: "inherit" },
  );
  if (r.status === 0) process.stdout.write(`gen:all: generated files restored to ${ref}\n`);
  return r.status ?? 1;
}
