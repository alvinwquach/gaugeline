import { ready, safe, why, idList } from "../content-model/shared.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { orphanCandidates, tallyFields } from "../sources/sanity-schema.js";

const MAX_TYPES = 100;

export const modelOrphanFields = defineCheck<PageSnapshot>({
  id: "model-orphan-fields",
  area: "Visitors",
  severity: "medium",
  title: "Documents still hold a field the schema no longer has",
  what: "Published documents have a value in a field that was removed from the schema: usually a leftover from before a rename, a merge or a clean-up.",
  why: "The Studio no longer shows the field, so nobody can see or fix what is in it, but a query or a page may still read it, and the old value can be wrong or private.",
  fix: "Decide for each field: if a page or query still needs it, put it back in the schema; if it moved to another field, copy the values across and then unset the old one with a one-off migration.",
  tech: "GROQ cannot list the keys a document has without sending the document, which Gaugeline never does, so the fields looked for are named: the fields of the schema file in previousSchema that the current schema no longer has, and the fields under retired in gaugeline.model.json. For each, count(*[_type == T && defined(field)]) over published documents and the first three ids in id order (GET). A field the current schema still has is never reported. No value is requested or shown. Without a schema file, or with no field named, the check is could not check",
  async run(page, ctx) {
    const r = ready(page, ctx, true);
    if (!r) return [];
    const candidates = orphanCandidates(r.schema, r.model.previousSchema, r.model.config.retired);
    if (candidates.size === 0) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        'No retired field is named, so nothing was looked for. Gaugeline cannot list the fields a document holds without reading the document. Add "previousSchema" (the schema file from before the change) or "retired" ({ "article": ["subtitle"] }) to gaugeline.model.json. See docs/sources/sanity-schema.',
      );
      return [];
    }
    const out: Finding[] = [];
    for (const [type, fields] of [...candidates].slice(0, MAX_TYPES)) {
      let tally;
      try {
        tally = await tallyFields(r.read, type, fields, "populated");
      } catch (err) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The documents of "${safe(type)}" could not be read: ${why(err)}`,
        );
        break;
      }
      for (const field of fields) {
        const n = tally.byField.get(field);
        if (!n || n.count === 0) continue;
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${n.count} of ${tally.total} published "${safe(type)}" document${tally.total === 1 ? "" : "s"} still ${n.count === 1 ? "has" : "have"} a value in "${safe(field, 40)}", which the schema no longer has (ids ${idList(n.ids)}${n.count > n.ids.length ? `, and ${n.count - n.ids.length} more` : ""})`,
          url: page.finalUrl,
        });
      }
    }
    return out;
  },
});
