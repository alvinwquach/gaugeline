import { posix } from "node:path";
import type { Finding } from "../../model.js";
import type { SourceTree } from "../../local-source/read.js";
import { closeOf, lineOf, scanSource } from "./source-scan.js";

/**
 * Reading source text for the static checks (batch FF). Plain string work, no compiler (the
 * TypeScript package is optional and a check must give the same findings wherever it runs, rule 7):
 * comments are blanked, string text can be blanked, and brackets are matched on the blanked copy. Every
 * view keeps the length of the original, so an index in one is an index in all and a line number is
 * the line of the file. Nothing here prints a file's text: a check says a file and a line.
 */

export { lineOf };

/** Source files by name. `.d.ts` files hold types only. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|e2e|cypress|stories)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/;

/** True for a source file a static check reads: code, but not a test or a story (they hold invented secrets on purpose). */
export function isSourcePath(path: string): boolean {
  return CODE_FILE.test(path) && !TEST_PATH.test(path);
}

/** The source files the reader kept, in path order. */
export function sourcePathsOf(tree: SourceTree): string[] {
  return [...tree.files.keys()].filter(isSourcePath).sort();
}

/**
 * Why a check that found nothing is not a pass: no source file was read, or some were left out
 * (too large, unreadable, a link). Gaugeline's words; `undefined` when the check can answer.
 */
export function notReadReason(tree: SourceTree): string | undefined {
  if (sourcePathsOf(tree).length === 0)
    return "no source file was read from the folder, so there was nothing to look at";
  const left = [...tree.skipped]
    .filter(([path, why]) => CODE_FILE.test(path) && why !== "secret-looking")
    .map(([path]) => path);
  return left.length === 0
    ? undefined
    : `${left.length} source ${left.length === 1 ? "file" : "files"} could not be read (too large, unreadable or a link), so what they hold is not known`;
}

/**
 * `text` with comments blanked (newlines kept); with `blank`, the text of strings and templates is
 * blanked too and the quotes and the `${...}` code stay. The same scanner every static check uses
 * (source-scan.ts), so a position in one view is the position in the other.
 */
export function scrub(text: string, blank: boolean): string {
  const scanned = scanSource(text);
  return blank ? scanned.bare : scanned.code;
}

/** The index of the bracket that closes the one at `open` in a scrubbed view; -1 when it never closes. */
export const matching = closeOf;

/** For each index, how many `{`, `(` and `[` are open before it: 0 means the top level of the module. */
export function depthMap(code: string): Int32Array {
  const depth = new Int32Array(code.length + 1);
  let d = 0;
  for (let k = 0; k < code.length; k++) {
    depth[k] = d;
    const c = code[k];
    if (c === "{" || c === "(" || c === "[") d++;
    else if (c === "}" || c === ")" || c === "]") d = Math.max(0, d - 1);
  }
  depth[code.length] = d;
  return depth;
}

const OPENER: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** The index of the bracket that opens the one at `close` in a scrubbed view; -1 when there is none. */
export function matchingBack(code: string, close: number): number {
  const closer = code[close] ?? "";
  const opener = OPENER[closer];
  if (opener === undefined) return -1;
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const c = code[k];
    if (c === closer) depth++;
    else if (c === opener && --depth === 0) return k;
  }
  return -1;
}

/** True when the file's first statement is the directive `"use client"` (or `use server`, ...). */
export function hasDirective(text: string, directive: string): boolean {
  const head = scrub(text, false).trimStart();
  const m = /^(?:(['"])([^'"\n]+)\1\s*;?\s*)+/.exec(head);
  return m !== null && new RegExp(`(['"])${directive}\\1`).test(m[0]);
}

/** Module specifiers a file imports or re-exports at run time (not `import type`), with the index of each. */
export function importsOf(code: string): { spec: string; index: number }[] {
  const out: { spec: string; index: number }[] = [];
  const re =
    /\b(?:import|export)\b(?!\s+type\b)(?:[^;"']{0,400}?\bfrom\b)?\s*(["'])([^"'\n]+)\1|\brequire\s*\(\s*(["'])([^"'\n]+)\3\s*\)/g;
  for (const m of code.matchAll(re)) out.push({ spec: m[2] ?? m[4] ?? "", index: m.index });
  return out;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * The file in the tree that `spec` names when imported from `from`: a relative path, or the `@/` and
 * `~/` shortcuts (the folder root or `src/`). Anything else (a package) is not in the tree: undefined.
 */
export function resolveImport(
  files: ReadonlyMap<string, string>,
  from: string,
  spec: string,
): string | undefined {
  const bases: string[] = [];
  if (spec.startsWith(".")) bases.push(posix.join(posix.dirname(from), spec));
  else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    bases.push(spec.slice(2), `src/${spec.slice(2)}`);
  }
  for (const base of bases) {
    const bare = base.replace(/\.[cm]?js$/, "");
    for (const stem of [base, bare])
      for (const candidate of [
        stem,
        ...EXTENSIONS.map((e) => stem + e),
        ...EXTENSIONS.map((e) => `${stem}/index${e}`),
      ])
        if (files.has(candidate) && isSourcePath(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Names that read a content system's token: a name with the system's name in it that ends in TOKEN,
 * SECRET or KEY (`SANITY_API_READ_TOKEN`, `CONTENTFUL_MANAGEMENT_TOKEN`, `PAYLOAD_SECRET`). Names
 * only; a value is never read.
 */
export function isCmsTokenName(name: string): boolean {
  const parts = name.toUpperCase().split("_");
  const last = parts[parts.length - 1] ?? "";
  return (
    ["TOKEN", "SECRET", "KEY"].includes(last) &&
    parts.some((p) =>
      [
        "SANITY",
        "CONTENTFUL",
        "STORYBLOK",
        "DATOCMS",
        "PRISMIC",
        "CONTENTSTACK",
        "HYGRAPH",
        "DIRECTUS",
        "STRAPI",
        "PAYLOAD",
        "KONTENT",
      ].includes(p),
    )
  );
}

/**
 * Every `process.env.NAME`, `process.env["NAME"]` and `import.meta.env.NAME` in a scrubbed view that
 * keeps strings, and every name in `const { NAME } = process.env`: the name and where. Names only.
 */
export function envReads(code: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  const direct =
    /\b(?:process\.env|import\.meta\.env)(?:\s*\.\s*([A-Za-z_]\w*)|\s*\[\s*(["'])([A-Za-z_]\w*)\2\s*\])/g;
  for (const m of code.matchAll(direct)) out.push({ name: m[1] ?? m[3] ?? "", index: m.index });
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g))
    for (const part of (m[1] ?? "").split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
      if (name !== undefined) out.push({ name, index: m.index });
    }
  return out;
}

/** Orders findings by file, then line, in place (the order a reader goes through a repository). */
export function sortFindings(findings: Finding[]): void {
  findings.sort((a, b) => {
    const fa = a.source?.file ?? "";
    const fb = b.source?.file ?? "";
    return fa === fb ? (a.source?.line ?? 0) - (b.source?.line ?? 0) : fa < fb ? -1 : 1;
  });
}
