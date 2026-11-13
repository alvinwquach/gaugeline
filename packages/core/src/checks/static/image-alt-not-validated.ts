import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { objectsAround, schemaTypes, viewsOf } from "./content-source.js";
import { lineOf, matching, notReadReason, sortFindings } from "./scan.js";

/**
 * FF-28 (the schema half): an image field in a Sanity schema that has no alt-text field, or one that
 * is not required. An editor can then publish a picture with no description, and the site renders it
 * with no alt text. The check reads `type: "image"` in the files that look like a schema, and looks in
 * that object's `fields` for a field named alt, altText or alt_text with `validation` that calls
 * `required(`. The other half of FF-28 (an image block that has no asset, on the live page) needs the
 * page and is covered by images-broken.
 *
 * // [GC] no source found (uncited): Sanity's image-field and validation pages are on sanity.io, which could not be reached.
 */
const ID = "image-alt-not-validated";

const ALT_NAMES = /^(?:alt|alt_?text)$/i;
const NAME = /(?<![\w$.])name\s*:\s*(["'])([\w-]+)\1/g;
const REQUIRED = /\bvalidation\s*:[\s\S]*\brequired\s*\(/;

export const imageAltNotValidated = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "Every image field has an alt-text field that an editor must fill in before publishing.",
  estimateChanges:
    "Adding the field and the rule is a few lines per image field. Writing alt text for pictures already published is the real work, and it is the client's or yours to schedule.",
  area: "Visitors",
  severity: "medium",
  title: "An image field can be published with no alt text",
  what: "A Sanity schema has an image field with no alt-text field, or an alt-text field an editor is not required to fill in.",
  why: "Alt text is what a screen reader says and what shows when a picture does not load. If the editor can leave it empty, some pictures will go live without it, and nobody sees the gap until someone who cannot see the picture visits.",
  fix: "Add a field to the image: defineField({ name: 'alt', type: 'string', title: 'Alternative text', validation: (Rule) => Rule.required() }). For a picture that is only decoration, give editors an explicit choice rather than an empty field.",
  tech: "reads the folder's code files (.env files never); in the files that define a Sanity schema, an object with type image whose fields list has no field named alt, altText or alt_text, or whose alt field has no validation calling required(, is a finding (the file, the line and the field's name); an image type defined once and reused is read where it is defined; no Sanity schema in the folder is could-not-check; the page-side half (an image block with no asset) is not read here",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const schema = schemaTypes(viewsOf(input));
    const findings: Finding[] = [];
    for (const t of schema.types) {
      if (t.type !== "image") continue;
      const { bare, code } = t.view;
      let ok = false;
      // The image's `fields: [ ... ]`, then the field in it named like alt, with a required rule.
      const fields = /\bfields\s*:\s*\[/.exec(code.slice(t.obj.start, t.obj.end));
      if (fields !== null) {
        const open = t.obj.start + fields.index + fields[0].length - 1;
        const close = matching(bare, open);
        for (const m of code.slice(open, close < 0 ? t.obj.end : close).matchAll(NAME)) {
          if (!ALT_NAMES.test(m[2] ?? "")) continue;
          const field = objectsAround(bare, open + m.index)[0];
          if (field !== undefined && REQUIRED.test(code.slice(field.start, field.end))) ok = true;
        }
      }
      if (ok) continue;
      findings.push({
        checkId: ID,
        severity: "medium",
        title: this.title,
        evidence: `${t.file}: the image field${t.name === undefined ? "" : ` "${t.name}"`} has no required alt-text field.`,
        url,
        source: { file: t.file, line: lineOf(code, t.index) },
      });
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why =
        notReadReason(tree) ??
        (!schema.found
          ? "no Sanity schema (defineType or defineField) was found in the folder, so the image fields are not known"
          : undefined);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
