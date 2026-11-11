import { pathMatches } from "../content-model/config.js";
import { findRawRefs, type RawRef } from "../content-model/raw-refs.js";
import { NOT_SET_UP, safe } from "../content-model/shared.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { pagesInScope, pathOf } from "../switches/shared.js";

function describe(ref: RawRef): string {
  switch (ref.kind) {
    case "object-object":
      return 'shows "[object Object]" where a value should be';
    case "ref-text":
      return "shows a raw reference (a _ref id) in its text";
    case "type-text":
      return "shows a raw _type name in its text";
    case "data-ref":
      return `holds a reference that was never expanded, at ${ref.where ?? "its data"}`;
  }
}

export const modelUnexpanded = defineCheck<PageSnapshot>({
  id: "model-unexpanded",
  size: "S",
  done: "The page prints the field's value, not a raw reference object.",
  estimateChanges: "The same query pattern repeated in several templates is one edit each.",
  area: "Visitors",
  severity: "high",
  title: "A page shows a raw reference where content should be",
  what: 'A live page shows a Sanity reference id, a type name or "[object Object]" instead of the content it points to, in its text, in an address, or in the data it embeds.',
  why: "A query that stopped following a reference (a missing ->) or a template that prints an object instead of a field still returns 200, so the page looks loaded and nobody opens it.",
  fix: "Follow the reference in the query (author->{name}) or print the field you meant, not the object. A page that shows an id on purpose goes under idsShownOn in gaugeline.model.json.",
  tech: 'Read from the HTML as sent, without JavaScript, on the checked page and the few it links to: visible text (scripts, styles and templates removed) with [object Object], a _ref key with its id or a quoted _type key; links and images whose address holds [object Object]; and JSON the page embeds (__NEXT_DATA__ and application/json scripts) holding an object with _type "reference" and a _ref. An asset reference (image-\u2026, file-\u2026) is how Sanity stores a picture, so it is not reported. At most five places per page; pages under idsShownOn are skipped. The evidence is the page, the piece of it and the id. Nothing is asked of Sanity',
  async run(page, ctx) {
    const model = ctx.model;
    if (!model) {
      ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const p of await pagesInScope(page, ctx)) {
      const path = new URL(p.finalUrl).pathname;
      if ((model.config.idsShownOn ?? []).some((pattern) => pathMatches(pattern, path))) continue;
      for (const ref of findRawRefs(p))
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${pathOf(p.finalUrl, origin)} ${describe(ref)}: "${ref.snippet}"${ref.id ? ` (reference id ${safe(ref.id, 80)})` : ""}`,
          url: p.finalUrl,
        });
    }
    return out;
  },
});
