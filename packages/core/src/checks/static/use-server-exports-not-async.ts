import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  depthMap,
  hasDirective,
  lineOf,
  notReadReason,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-17: a file that starts with "use server" and exports something that is not an async function: a
 * constant, a plain function, a class or an enum. Read at the top level of the module (type-only
 * exports are fine). An export whose kind the text cannot settle (a call that wraps a function, a name
 * imported from elsewhere, `export *`) is not guessed at: it is could-not-check, never a pass.
 *
 * The check text does not say that Next refuses such an export: the page that was read states no such
 * rule.
 *
 * // [docs] next@16.4.1 > use server - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/01-directives/use-server.mdx (the directive "designates a function or file to be executed on the server side"; "All functions in the file are executed on the server"; its examples export only async functions)
 * // [docs] next@16.4.1 > data-security, "Preventing client-side execution of server-only code" - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/data-security.mdx (lines 243-255: import "server-only")
 * // [GC] no source found (uncited): that Next rejects or exposes a non-async export is not stated on the page that was read.
 */
const ID = "use-server-exports-not-async";

type Kind = "ok" | "bad" | "unsure";

/** What a `= init` is, from its first tokens. */
function initKind(init: string): Kind {
  if (/^async\b/.test(init)) return "ok";
  if (/^(?:["'`\d[{\-!+]|true\b|false\b|null\b|undefined\b|new\b|function\b|class\b)/.test(init))
    return "bad";
  if (/^(?:\([^()]*\)|[\w$]+)\s*(?::[^=]+?)?=>/.test(init)) return "bad";
  return "unsure";
}

export const useServerExportsNotAsync = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "Every export of a 'use server' file is an async function; constants, helpers and classes live in a module of their own.",
  estimateChanges:
    "Moving a constant or helper to its own file is minutes. A helper imported by many client components means updating each import.",
  area: "Launch day",
  severity: "medium",
  title: "A 'use server' file exports something that is not an async function",
  what: "A file that starts with 'use server' exports a constant, a plain function, a class or an enum next to its server functions.",
  why: "A 'use server' file is a file of server functions that client components import and call, and the examples in Next.js's documentation export only async functions there. A constant or helper exported from it is not a server function and does not belong in it. Putting the value in a module of its own keeps the file's exports honest.",
  fix: "Move the constant, helper or class to another module and import it where needed. If it must stay on the server, start that module with import 'server-only', so a client import fails the build.",
  tech: "reads the folder's code files (.env files never); in a file whose first statement is 'use server', a top-level export of a const, let or var whose value is plainly not async (a literal, object, array, new, class, function, non-async arrow), a non-async function, a class or an enum is a finding; type-only exports are ignored; an export whose kind the text cannot settle (a wrapped call, an imported name, export *) is could-not-check; the finding is the file, the line and the exported name; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    const unsure: string[] = [];
    for (const file of sourcePathsOf(tree)) {
      const text = tree.files.get(file) ?? "";
      if (!hasDirective(text, "use server")) continue;
      const code = scrub(text, false);
      const bare = scrub(text, true);
      const depth = depthMap(bare);
      const bad = (index: number, name: string, what: string): void => {
        findings.push({
          checkId: ID,
          severity: "medium",
          title: this.title,
          evidence: `${file}: exports ${name}, ${what}, from a "use server" file.`,
          url,
          source: { file, line: lineOf(code, index) },
        });
      };
      /** A top-level name declared in this file: what it is, or undefined when it is not declared here. */
      const declared = (name: string): Kind | undefined => {
        const id = name.replace(/\$/g, "\\$");
        for (const m of bare.matchAll(
          new RegExp(`(?<![\\w$.])(async\\s+)?function\\s*\\*?\\s*${id}\\b`, "g"),
        ))
          if (depth[m.index] === 0) return m[1] === undefined ? "bad" : "ok";
        for (const m of bare.matchAll(
          new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=]+?)?=\\s*`, "g"),
        ))
          if (depth[m.index] === 0) return initKind(bare.slice(m.index + m[0].length));
        for (const m of bare.matchAll(new RegExp(`\\b(?:class|enum)\\s+${id}\\b`, "g")))
          if (depth[m.index] === 0) return "bad";
        return undefined;
      };
      for (const m of bare.matchAll(/\bexport\b\s*/g)) {
        if (depth[m.index] !== 0) continue;
        const rest = bare.slice(m.index + m[0].length);
        if (/^(?:type|interface|declare)\b/.test(rest)) continue;
        let r: RegExpExecArray | null;
        if ((r = /^default\s+(async\s+)?function\b/.exec(rest)) !== null) {
          if (r[1] === undefined) bad(m.index, "a default function", "which is not async");
        } else if (/^default\b/.test(rest)) {
          if (!/^default\s+async\b/.test(rest)) unsure.push(file);
        } else if ((r = /^(async\s+)?function\s*\*?\s*([\w$]+)/.exec(rest)) !== null) {
          if (r[1] === undefined)
            bad(m.index, r[2] ?? "a function", "a function that is not async");
        } else if ((r = /^(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+?)?=\s*/.exec(rest)) !== null) {
          const kind = initKind(rest.slice(r[0].length));
          if (kind === "bad")
            bad(m.index, r[1] ?? "a value", "a value that is not an async function");
          else if (kind === "unsure") unsure.push(file);
        } else if ((r = /^(?:abstract\s+)?(?:class|enum)\s+([\w$]+)/.exec(rest)) !== null) {
          bad(m.index, r[1] ?? "a class", "which is not an async function");
        } else if (rest.startsWith("{")) {
          const close = rest.indexOf("}");
          if (/^\{[^}]*\}\s*from\b/.test(rest)) unsure.push(file);
          else
            for (const part of rest.slice(1, close).split(",")) {
              const local = /^\s*(?:type\s+)?([\w$]+)/.exec(part);
              if (local === null || /^\s*type\s+/.test(part)) continue;
              const kind = declared(local[1] ?? "");
              if (kind === "bad")
                bad(m.index, local[1] ?? "a name", "which is not an async function");
              else if (kind !== "ok") unsure.push(file);
            }
        } else if (rest.startsWith("*")) unsure.push(file);
      }
    }
    sortFindings(findings);
    const files = [...new Set(unsure)];
    if (files.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${files.length === 1 ? `${files[0]} has` : `${files.length} 'use server' files have`} an export whose kind cannot be told from the text (a wrapped call, an imported name or export *)`,
      );
    if (findings.length === 0 && files.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
