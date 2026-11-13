import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  depthMap,
  envReads,
  isCmsTokenName,
  lineOf,
  matching,
  notReadReason,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-15: a module that throws when a content-system token is missing, as soon as it is imported. Every
 * build, test and CI job that imports it then needs the secret. Read at the top level of a module (not
 * inside a function): an `if` whose condition reads the token variable (or a constant set from it) and
 * whose body throws, an `invariant(` or `assert(` of it, or `process.env.X ?? (() => { throw ... })()`.
 * A NEXT_PUBLIC_ name is left to cms-token-in-client-code. Scripts, seed and migration files, and
 * `*.config.*` and `sanity.cli.*` files, are left alone: a command that needs the token may say so.
 *
 * // [docs] next@16.4.1 > environment-variables - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/environment-variables.mdx (lines 156-158: a variable without NEXT_PUBLIC_ exists only in Node.js; supports "read it where it is used", not the advice to read it lazily)
 * // [GC] no source found (uncited): that reading it lazily, on the draft path only, is the better shape is advice, not framework behaviour.
 */
const ID = "token-required-at-import";

const SKIPPED =
  /(?:^|\/)(?:scripts?|seeds?|migrations?|bin)\/|\.config\.[cm]?[jt]s$|(?:^|\/)sanity\.cli\.[cm]?[jt]s$/;
const ASSERTS = /(?<![\w$.])(?:invariant|assert|assertEnv|requireEnv)\s*\(/g;

export const tokenRequiredAtImport = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "Importing a module never needs the content token: it is read inside the function that uses it, on the draft or write path only.",
  estimateChanges:
    "Wrapping the read in a function is minutes. A token read in many modules at the top level means going through each import.",
  area: "Launch day",
  severity: "medium",
  title: "A module needs the content token just to be imported",
  what: "A module throws, at the top level, when a content-system token (Sanity, Contentful and others) is not set.",
  why: "Everything that imports the module, even for a page that never reads a draft, now fails without the secret: every build, every test run, every preview and every CI job. A freelancer ends up putting a fake token in each of them, and a missing token breaks the whole site instead of the one page that needed it.",
  fix: "Read the token inside the function that needs it (the draft preview, the write), and throw there. Public published reads need no token at all.",
  tech: "reads the folder's code files (.env files never); at the top level of a module (not inside a function or block), an if whose condition reads a variable named like a content-system token (a content system's name and TOKEN, SECRET or KEY) or a constant set from it and whose body throws, an invariant or assert call of it, or the variable followed by ?? or || and a throw, is a finding; the finding is the file, the line and the variable's name; NEXT_PUBLIC_ names, scripts, seed, migrations and bin folders, *.config.* files and sanity.cli files are left alone; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    for (const file of sourcePathsOf(tree)) {
      if (SKIPPED.test(file)) continue;
      const text = tree.files.get(file) ?? "";
      const code = scrub(text, false);
      const bare = scrub(text, true);
      const depth = depthMap(bare);
      const reads = envReads(code).filter(
        (r) => isCmsTokenName(r.name) && !r.name.startsWith("NEXT_PUBLIC_"),
      );
      if (reads.length === 0) continue;
      // Constants set from the token at the top level, so `if (!token) throw` is read as the token.
      const idents = new Map<string, string>();
      for (const m of code.matchAll(
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*(?:process\.env|import\.meta\.env)\s*\.\s*([A-Za-z_]\w*)/g,
      ))
        if (depth[m.index] === 0 && isCmsTokenName(m[2] ?? "")) idents.set(m[1] ?? "", m[2] ?? "");
      /** The token a piece of code reads, directly or through a constant set from it. */
      const named = (slice: string): string | undefined => {
        for (const r of envReads(slice))
          if (isCmsTokenName(r.name) && !r.name.startsWith("NEXT_PUBLIC_")) return r.name;
        for (const [id, name] of idents)
          if (new RegExp(`(?<![\\w$.])${id.replace(/\$/g, "\\$")}(?![\\w$])`).test(slice))
            return name;
        return undefined;
      };
      const hit = (index: number, name: string): void => {
        findings.push({
          checkId: ID,
          severity: "medium",
          title: this.title,
          evidence: `${file}: throws when ${name} is missing, as soon as the module is imported.`,
          url,
          source: { file, line: lineOf(code, index) },
        });
      };
      for (const m of bare.matchAll(/\bif\s*\(/g)) {
        if (depth[m.index] !== 0) continue;
        const open = m.index + m[0].length - 1;
        const close = matching(bare, open);
        if (close < 0) continue;
        const name = named(code.slice(open, close));
        if (name === undefined) continue;
        let at = close + 1;
        while (/\s/.test(bare[at] ?? "")) at++;
        const end = bare[at] === "{" ? matching(bare, at) : bare.indexOf(";", at);
        if (end > at && /\bthrow\b/.test(bare.slice(at, end))) hit(m.index, name);
      }
      for (const m of bare.matchAll(ASSERTS)) {
        if (depth[m.index] !== 0) continue;
        const open = m.index + m[0].length - 1;
        const close = matching(bare, open);
        const name = close < 0 ? undefined : named(code.slice(open, close));
        if (name !== undefined) hit(m.index, name);
      }
      for (const t of reads) {
        if (depth[t.index] !== 0) continue;
        const after = code.slice(t.index, t.index + 240);
        if (
          /^(?:process\.env|import\.meta\.env)[^;\n]*?(?:\?\?|\|\|)\s*(?:\(\s*\(\s*\)\s*=>\s*\{[^}]*\bthrow\b|throw\w*\s*\()/.test(
            after,
          )
        )
          hit(t.index, t.name);
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
