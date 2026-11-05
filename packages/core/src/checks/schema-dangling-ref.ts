import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { schemaPages, warnSkipped } from "./schema/common.js";
import { firstFew } from "./site-helpers.js";

export const schemaDanglingRef = defineCheck<PageSnapshot>({
  id: "schema-dangling-ref",
  area: "Search & sharing",
  severity: "medium",
  title: "Structured data refers to something that isn't there",
  what: 'A structured data reference ({"@id": ...}) points at a node that is not defined on the page or on the other pages checked.',
  why: "Search engines can't follow the reference, so whatever it stands for (the publisher, the author, the organization) is lost.",
  fix: "Define the node the reference names (usually on the homepage), or correct the @id to the one you use.",
  tech: "an object with only an @id resolves (after normalisation) to no @id defined on the sampled pages",
  async run(page, ctx) {
    const pages = await schemaPages(page, ctx);
    warnSkipped(pages, ctx, "schema-dangling-ref");
    const defined = new Set<string>();
    for (const p of pages) for (const id of p.flat.byId.keys()) defined.add(id);
    const out = [];
    for (const p of pages) {
      const dangling = [
        ...new Set(p.flat.refs.filter((r) => !defined.has(r.id)).map((r) => r.raw)),
      ];
      if (dangling.length === 0) continue;
      out.push({
        checkId: "schema-dangling-ref",
        severity: "medium" as const,
        title: this.title,
        evidence: `${p.path} refers to ${firstFew(dangling.map((d) => `"${d}"`))}, defined on none of the ${pages.length} pages checked`,
        url: p.page.finalUrl,
      });
    }
    return out;
  },
});
