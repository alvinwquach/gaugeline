import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { groqQueries, schemaTypes, viewsOf } from "./content-source.js";
import { lineOf, notReadReason, sortFindings } from "./scan.js";

/**
 * FF-26: a GROQ query that asks for a reference field by name and never follows it with `->`. A
 * reference field holds a small object with the id of another document, so the page gets that object
 * and not the document's name, title or image. The check reads the schema in the folder for the names
 * of the fields declared `type: "reference"` (also as the members of an array), and the GROQ queries
 * written as string or template literals that start with `*[`. A projection item that is exactly such a
 * name (`author`, or `"writer": author`) and is not followed by `->` is a finding. It runs no query and
 * reads no dataset. A field with that name that is not a reference elsewhere in the schema is a false
 * positive the docs page names.
 *
 * Not sure is not a pass: no Sanity schema in the folder, or no query written in the source (queries
 * kept in .groq files or built from pieces are not read), is could-not-check.
 *
 * // [GC] no source found (uncited): the GROQ reference page ("->" follows a reference) is on sanity.io, which could not be reached. groq-js is already pinned in the repository (2.0.1), but this check does not run it.
 */
const ID = "groq-reference-not-expanded";

export const groqReferenceNotExpanded = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "Every reference a query asks for is followed with -> and the fields wanted, so the page gets the name or image and not an id.",
  estimateChanges:
    "Adding -> and a projection is a line per query. A query shared by many pages means checking each page's use of the result.",
  area: "Visitors",
  severity: "medium",
  title: "A query asks for a reference without following it",
  what: "A GROQ query lists a reference field (an author, a category, a linked page) and does not follow it with ->, so the result holds a reference and not the document.",
  why: "A page built from that result has an id where the author's name, the category's title or the linked page's address should be: a link that goes nowhere, a name that is missing, or the text [object Object] on the page.",
  fix: "Follow the reference and say what you want from it: author->{ name, 'photo': image.asset->url }. For a list of references, author[]->{ name }.",
  tech: "reads the folder's code files (.env files never): the names of the schema fields declared with type reference (also as the members of an array of references), and the GROQ queries written as string or template literals that start with *[; a projection item that is exactly such a name, or an alias of it, and is not followed by -> is a finding (the file, the line and the field's name); a name used elsewhere in the schema for a non-reference field is a false positive; no query is run; no schema in the folder, or no query written in the source, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const views = viewsOf(input);
    const schema = schemaTypes(views);
    const refs = new Map<string, string>();
    for (const t of schema.types)
      if (t.type === "reference" && t.name !== undefined && !refs.has(t.name))
        refs.set(t.name, t.file);
    const queries = views.flatMap(groqQueries);
    const findings: Finding[] = [];
    for (const q of queries) {
      const view = views.find((v) => v.file === q.file);
      for (const [name, schemaFile] of refs) {
        const re = new RegExp(`(?<![\\w$.>"'@^-])${name}(?=\\s*(?:,|\\}|$))`, "gm");
        for (const m of q.text.matchAll(re)) {
          findings.push({
            checkId: ID,
            severity: "medium",
            title: this.title,
            evidence: `${q.file}: the query asks for "${name}" without ->, and ${schemaFile} declares it as a reference.`,
            url,
            source: { file: q.file, line: lineOf(view?.code ?? "", q.index + 1 + m.index) },
          });
        }
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why =
        notReadReason(tree) ??
        (!schema.found
          ? "no Sanity schema (defineType or defineField) was found in the folder, so the reference fields are not known"
          : queries.length === 0
            ? "no GROQ query written as a string in the source was found (queries kept in other files or built from pieces are not read)"
            : undefined);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
