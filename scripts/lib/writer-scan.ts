/**
 * ADR-0010, owner decision 4: the writer pushes a branch and opens a pull request, and never merges.
 * This scan fails any source file in the writer package that could ask for a merge: the REST merge
 * endpoints, GraphQL's merge and auto-merge mutations, Octokit's merge methods, the git and gh
 * commands, and the words themselves. It is deliberately blunt: the writer has no reason to say
 * "merge" at all, so a comment that says it is refused too.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The package the writer lives in (ADR-0010, owner decision 6), relative to the repository root. */
export const WRITER_DIR = "packages/writer";

const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: "a merge word", pattern: /merg/i },
  { name: "auto-merge", pattern: /auto[\s_-]?merg/i },
  { name: "a merge endpoint", pattern: /\/(pulls\/[^/\s"'`]+\/)?merges?\b/i },
  {
    name: "a merge mutation",
    pattern: /(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)/i,
  },
];

/**
 * The text a file would run with: string pieces joined ("mer" + "ge"), and unicode and hex escapes
 * decoded, so splitting a word does not hide it.
 */
export function normalise(text: string): string {
  return text
    .replace(/(["'`])\s*\+\s*(["'`])/g, "")
    .replace(
      /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g,
      (_, braced?: string, four?: string) =>
        String.fromCodePoint(parseInt(braced ?? four ?? "0", 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Problems in one file's text: the rule broken and the line. */
export function mergeProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  normalise(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const f of FORBIDDEN)
        if (f.pattern.test(line)) problems.push(`${name}:${i + 1}: ${f.name} in the writer.`);
    });
  return problems;
}

/** Every source file under a directory, tests included (a test helper could merge too). */
export function writerSources(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const full = join(dir, n);
    if (["node_modules", "dist"].includes(n)) return [];
    if (statSync(full).isDirectory()) return writerSources(full);
    return /\.(c|m)?(t|j)sx?$/.test(n) || n === "package.json" ? [full] : [];
  });
}

/**
 * ADR-0010: "a publish call doesn't exist in the code". The same blunt scan for the content system's other
 * way to change something live, over the writer's runtime source (tests excluded: they name what is
 * refused). It reads the text the way `mergeProblems` does (`normalise`: joined string pieces and escapes
 * decoded), so splitting a word does not hide it. "publish" also catches "unpublish".
 */
const FORBIDDEN_LIVE: readonly { name: string; pattern: RegExp }[] = [
  { name: "a publish word", pattern: /publish/i },
  { name: "a discard word", pattern: /discard/i },
];

/** Problems in one runtime file's text: the rule broken and the line. */
export function publishProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  normalise(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const f of FORBIDDEN_LIVE)
        if (f.pattern.test(line)) problems.push(`${name}:${i + 1}: ${f.name} in the writer.`);
    });
  return problems;
}

/** The writer's runtime sources: every file `writerSources` finds, except under a `__tests__` folder. */
export function writerRuntimeSources(dir: string): string[] {
  return writerSources(dir).filter((f) => !/[\\/]__tests__[\\/]/.test(f));
}
