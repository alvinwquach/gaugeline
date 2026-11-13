import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  envReads,
  hasDirective,
  importsOf,
  isCmsTokenName,
  lineOf,
  notReadReason,
  resolveImport,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-18: a content system's token that code sent to the browser can reach.
 *
 * Two shapes, both read from source and neither needing the site:
 * 1. a `NEXT_PUBLIC_` variable named like a content-system token. Next copies the value of such a
 *    variable into the JavaScript every visitor downloads;
 * 2. a module that reads a token variable, has no `import "server-only"`, and is imported, directly
 *    or through other modules, by a file that starts with "use client".
 * It looks at names and import lines only. It never keeps a value, and a finding names a file, a line
 * and the variable's name (a name is not a secret).
 *
 * Not covered, and said so in the docs: the Pages Router (a page file is both), aliases other than
 * `@/` and `~/`, and "the published path" (whether a published read is made with the token), which
 * source text does not settle.
 *
 * // [docs] next@16.4.1 > environment-variables, "Bundling Environment Variables for the Browser" - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/environment-variables.mdx (lines 156-158: variables without NEXT_PUBLIC_ are only available in Node.js; NEXT_PUBLIC_ values are inlined into the JavaScript bundle at build time)
 * // [docs] next@16.4.1 > data-security, "Preventing client-side execution of server-only code" - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/data-security.mdx (lines 243-255: mark a module with import "server-only")
 */
const ID = "cms-token-in-client-code";

const SERVER_ONLY = /\bimport\s*(["'])server-only\1|\brequire\s*\(\s*(["'])server-only\2\s*\)/;

export const cmsTokenInClientCode = defineCheck<LocalSourceInput>({
  id: ID,
  size: "M",
  done: "No content-system token is named NEXT_PUBLIC_, and every module that reads one imports server-only and is never imported by a client component.",
  estimateChanges:
    "A token read in one small module is a one-line import and a rename. A token read all over client components means moving those reads behind a server function or a route first.",
  area: "Security & email",
  severity: "high",
  title: "A content-system token is in code that is sent to the browser",
  what: "The source reads a content-system token (Sanity, Contentful and others) in a NEXT_PUBLIC_ variable, or in a module that a client component imports.",
  why: "A NEXT_PUBLIC_ value is copied into the JavaScript every visitor downloads, so anyone can read the token from the page and use it against your content: a read token shows your unpublished drafts, a write token can change or delete them. A module a client component imports is built for the browser too, where a server-only variable is empty, and the usual quick fix is to rename the variable with NEXT_PUBLIC_.",
  fix: "Keep the token in a variable without NEXT_PUBLIC_, read it only in a server module (a route handler, a server component or a server function), and put import 'server-only' at the top of that module so a client import fails the build. Pass the content to client components as props. If a token was ever published, create a new one and delete the old.",
  tech: "reads the folder's source files only (never .env files; values are not kept); a NEXT_PUBLIC_ variable whose name has a content system's name and ends in TOKEN, SECRET or KEY is a finding; so is a module that reads such a variable, has no import of server-only, and is reached from a file whose first statement is 'use client' through relative imports and the @/ and ~/ shortcuts (type-only imports are ignored); the finding is the file, the line and the variable's name; Pages Router pages and other aliases are not followed; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const code = new Map<string, string>();
    for (const path of sourcePathsOf(tree))
      code.set(path, scrub(tree.files.get(path) ?? "", false));

    const findings: Finding[] = [];
    const found = (file: string, index: number, evidence: string): void => {
      findings.push({
        checkId: ID,
        severity: "high",
        title: this.title,
        evidence: `${file}: ${evidence}`,
        url,
        source: { file, line: lineOf(code.get(file) ?? "", index) },
      });
    };

    // 1. The token named NEXT_PUBLIC_.
    const readers = new Map<string, { name: string; index: number }>();
    for (const [file, text] of code) {
      const names = new Set<string>();
      for (const read of envReads(text)) {
        if (!isCmsTokenName(read.name)) continue;
        if (read.name.startsWith("NEXT_PUBLIC_")) {
          if (names.has(read.name)) continue;
          names.add(read.name);
          found(
            file,
            read.index,
            `reads ${read.name}. Next puts the value of a NEXT_PUBLIC_ variable into the JavaScript every visitor downloads.`,
          );
        } else if (!SERVER_ONLY.test(text) && !readers.has(file)) readers.set(file, read);
      }
    }

    // 2. A module that reads a token, imported by a client component.
    if (readers.size > 0) {
      const reachedFrom = new Map<string, string>();
      for (const [root, text] of code) {
        if (!hasDirective(tree.files.get(root) ?? "", "use client")) continue;
        const queue = [root];
        reachedFrom.set(root, reachedFrom.get(root) ?? root);
        for (let at = queue.shift(); at !== undefined; at = queue.shift())
          for (const { spec } of importsOf(code.get(at) ?? text)) {
            const target = resolveImport(tree.files, at, spec);
            if (target === undefined || reachedFrom.has(target)) continue;
            reachedFrom.set(target, root);
            queue.push(target);
          }
      }
      for (const [file, read] of readers) {
        const root = reachedFrom.get(file);
        if (root === undefined) continue;
        found(
          file,
          read.index,
          root === file
            ? `reads ${read.name} in a file marked "use client", so it is built for the browser.`
            : `reads ${read.name}, and ${root} (a client component) imports it, so it is built for the browser.`,
        );
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
