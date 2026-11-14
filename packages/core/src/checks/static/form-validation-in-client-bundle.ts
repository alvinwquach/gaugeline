import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  hasDirective,
  importsOf,
  lineOf,
  notReadReason,
  resolveImport,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-25 (advice): a form's validation library (zod, yup, valibot, joi, superstruct, arktype) loaded into
 * the client bundle when the component only reads field names from the schema (`.shape`, `.keyof()`),
 * never validates with it. A `"use client"` file that imports a schema module, or defines a schema
 * itself, and whose every use of the schema is a read of its field names is a finding. Any validation
 * (`parse`, `safeParse`, `validate`, a resolver) means the browser needs the library and is left alone;
 * a use Gaugeline cannot read is could-not-check. Static: it reads the code and runs none of it.
 *
 * // [docs] next@16.4.1 > Server and Client Components - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/01-getting-started/05-server-and-client-components.mdx (line 180: once a file is marked "use client", all of its imports and the components it directly renders are included in the client bundle)
 * // [docs] zod@4.6.7 > Objects, .shape and .keyof() - https://raw.githubusercontent.com/colinhacks/zod/b500a2ee95134f81d74da7911d7378dd2853d042/packages/docs/content/api.mdx (lines 1293-1319, read at the commit npm records as gitHead of 4.6.7: .shape gives access to the internal schemas and .keyof() makes an enum of the keys)
 * // [GC] no source found (uncited): the size of the library, and that a plain list of field names is the better shape for a client component. The other libraries' documentation was not read; the check text says what the code does and not how large the download is.
 */
const ID = "form-validation-in-client-bundle";

const LIBS = ["zod", "yup", "valibot", "joi", "@hapi/joi", "superstruct", "arktype"];
const libOf = (spec: string): boolean => LIBS.some((l) => spec === l || spec.startsWith(`${l}/`));

/** A schema declared as `const name = <lib>.object(...)`, or with a bare `object(` or `type(` call. */
const SCHEMA_DECL =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:object|strictObject|looseObject|type)\s*\(/g;
const NAMES_ONLY = /^\s*\.\s*(?:shape|keyof|entries|fields)\b/;
const VALIDATES =
  /^\s*\.\s*(?:parse|safeParse|parseAsync|safeParseAsync|spa|validate|validateSync|validateAsync|isValid|isValidSync|cast|assert|check|is|create|test)\b/;
const VALIDATING_CHAIN = /\b(?:parse|safeParse|parseAsync|safeParseAsync|validate|validateSync)\b/;
const IMPORT_CLAUSE = /\bimport\s+(?!type\b)([^;'"]*?)\s*from\s*(["'])([^"'\n]+)\2/g;

const declared = (bare: string): Set<string> =>
  new Set([...bare.matchAll(SCHEMA_DECL)].map((m) => m[1] ?? ""));

/** The local names an import clause gives to the named or default exports in `want` (all, when undefined). */
function boundNames(clause: string, want: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
  for (const part of named.split(",")) {
    const [from = "", to] = part.trim().split(/\s+as\s+/);
    if (from !== "" && !from.startsWith("type ") && want.has(from)) out.push(to ?? from);
  }
  return out;
}

type Use = "names" | "validates" | "unknown";

/** How the file uses a name: the weakest reading wins (validates, then unknown, then names only). */
function useOf(bare: string, name: string, skip: [number, number][]): Use | undefined {
  let found: Use | undefined;
  for (const m of bare.matchAll(
    new RegExp(`(?<![\\w$])(?<![\\w$)\\]]\\s*\\.)${name.replace(/\$/g, "\\$")}\\b`, "g"),
  )) {
    if (skip.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const before = bare.slice(Math.max(0, m.index - 40), m.index);
    if (/\btypeof\s+$/.test(before) || /\b(?:const|let)\s+$/.test(before)) continue;
    const after = bare.slice(m.index + name.length, m.index + name.length + 80);
    let use: Use = "unknown";
    if (VALIDATES.test(after) || /resolver\s*\(\s*$/i.test(before)) use = "validates";
    else if (NAMES_ONLY.test(after))
      use = VALIDATING_CHAIN.test(/^(?:\s*\.\s*[\w$]+)*/.exec(after)?.[0] ?? "")
        ? "validates"
        : "names";
    if (use === "validates") return use;
    if (found === undefined || use === "unknown") found = use;
  }
  return found;
}

export const formValidationInClientBundle = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "A client component gets its field names from a plain list, and the validation library is imported only where a schema validates a submission.",
  estimateChanges:
    "Minutes: export the field names as an array next to the schema, or derive them in the server component and pass them down. More if the same schema also validates in the browser.",
  area: "Visitors",
  severity: "low",
  title: "A form loads its validation library into the browser only to read field names",
  what: "A client component imports a schema (zod, yup, valibot and similar) or defines one, and the only thing it does with it is read its field names (.shape, .keyof()).",
  why: "Everything a client component imports is sent to the visitor's browser. The validation library, and the whole schema with its rules, are downloaded on every page with the form, so that the page can list a few field names a plain array would hold.",
  fix: "Export the field names as a plain list, or derive them in a server component and pass them in. Keep the schema where the submission is validated, on the server.",
  tech: 'reads the code files of the folder named, never runs them; a file that starts with "use client" and imports, from a local module that loads zod, yup, valibot, joi, superstruct or arktype, a schema declared as const x = <lib>.object(...), or declares one itself after importing the library, and whose every use of it is .shape, .keyof(), .entries or .fields (a use only in a type does not count) is a finding at the import; a parse, safeParse, validate or resolver call means the browser validates and is left alone; a use Gaugeline cannot read (assigned, passed on, exported) is could-not-check; no source file read, or some left out, is could-not-check; the finding names the files and the library, never a field name',
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    const unsure: string[] = [];
    const judge = (
      file: string,
      line: number,
      names: string[],
      skip: [number, number][],
      bare: string,
      how: string,
    ): void => {
      const uses = names.map((n) => useOf(bare, n, skip));
      if (uses.includes("validates") || uses.every((u) => u === undefined)) return;
      if (uses.includes("unknown")) {
        unsure.push(file);
        return;
      }
      findings.push({
        checkId: ID,
        severity: "low",
        title: this.title,
        evidence: `${file}:${line}: ${how}`,
        url,
        source: { file, line },
      });
    };
    for (const file of sourcePathsOf(tree)) {
      const text = tree.files.get(file) ?? "";
      if (!hasDirective(text, "use client")) continue;
      const code = scrub(text, false);
      const bare = scrub(text, true);
      const own = importsOf(code).find((i) => libOf(i.spec));
      if (own !== undefined) {
        const names = [...declared(bare)];
        if (names.length > 0)
          judge(
            file,
            lineOf(code, own.index),
            names,
            [],
            bare,
            `this client component loads ${own.spec} and only reads field names from a schema it defines.`,
          );
        continue;
      }
      for (const m of code.matchAll(IMPORT_CLAUSE)) {
        const target = resolveImport(tree.files, file, m[3] ?? "");
        if (target === undefined) continue;
        const targetText = tree.files.get(target) ?? "";
        const lib = importsOf(scrub(targetText, false)).find((i) => libOf(i.spec));
        if (lib === undefined) continue;
        const names = boundNames(m[1] ?? "", declared(scrub(targetText, true)));
        if (names.length === 0) continue;
        judge(
          file,
          lineOf(code, m.index),
          names,
          [[m.index, m.index + m[0].length]],
          bare,
          `this client component imports ${target}, which loads ${lib.spec}, and only reads field names from it.`,
        );
      }
    }
    sortFindings(findings);
    if (unsure.length > 0)
      ctx.couldNotCheck?.(
        url,
        `${[...new Set(unsure)].join(", ")} uses a schema in a way Gaugeline cannot read, so it cannot tell whether the form validates with it`,
      );
    if (findings.length === 0 && unsure.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
