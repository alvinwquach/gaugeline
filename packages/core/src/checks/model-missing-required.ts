import { idList, ready, safe, why } from "../content-model/shared.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { modelOf, tallyFields } from "../sources/sanity-schema.js";

/** Document types asked about in one run; a schema with more says so. */
const MAX_TYPES = 100;

export const modelMissingRequired = defineCheck<PageSnapshot>({
  id: "model-missing-required",
  size: "M",
  done: "The documents named in the evidence have the field filled in and the schema check passes.",
  estimateChanges:
    "Many documents need a one-off migration. A few are filled in by hand in the Studio.",
  area: "Visitors",
  severity: "high",
  title: "Published documents are missing a field the schema now requires",
  what: "The schema says every document of a type must have a field, and published documents of that type do not have it: the ones written before the field was required.",
  why: "Older documents never got the new field, so a page or a query that depends on it shows an empty section, or drops those documents, on pages nobody opened since the change.",
  fix: "Fix first when the document's page is live. Open the documents named in the evidence in the Studio and fill the field in, or run a one-off migration that sets it; then, if a few are meant to be empty, make the field optional in the schema.",
  tech: "From the schema file named in gaugeline.model.json (sanity schema extract): each document type's fields, required unless the extract says optional. For each required field one GROQ query over published documents only (perspective=published, GET) returns two numbers and ids: count(*[_type == T && !defined(field)]) and the first three ids in id order. Grouped by type and field. No field value is requested or shown; a field required only on some types is judged on those types. Without a schema file the check is could not check",
  async run(page, ctx) {
    const r = ready(page, ctx, true);
    if (!r) return [];
    const out: Finding[] = [];
    const types = [...modelOf(r.schema)].filter(([, t]) => t.required.length > 0);
    if (types.length > MAX_TYPES)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `The schema has ${types.length} document types with required fields; the first ${MAX_TYPES} were checked.`,
      );
    for (const [type, t] of types.slice(0, MAX_TYPES)) {
      let tally;
      try {
        tally = await tallyFields(r.read, type, t.required, "missing");
      } catch (err) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The documents of "${safe(type)}" could not be read: ${why(err)}`,
        );
        break;
      }
      if (tally.skipped.length > 0)
        ctx.couldNotCheck?.(
          page.finalUrl,
          `${tally.skipped.length} required field${tally.skipped.length === 1 ? "" : "s"} of "${safe(type)}" (${tally.skipped.map((f) => safe(f, 30)).join(", ")}) could not be checked: the name cannot be written into a query.`,
        );
      for (const field of t.required) {
        const n = tally.byField.get(field);
        if (!n || n.count === 0) continue;
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${n.count} of ${tally.total} published "${safe(type)}" document${tally.total === 1 ? "" : "s"} ${n.count === 1 ? "has" : "have"} no "${safe(field, 40)}", which the schema now requires (ids ${idList(n.ids)}${n.count > n.ids.length ? `, and ${n.count - n.ids.length} more` : ""})`,
          url: page.finalUrl,
        });
      }
    }
    return out;
  },
});
