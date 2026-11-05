import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { jsonLdTypes, schemaType } from "./structured/collect.js";

export const structuredDuplicate = defineCheck<PageSnapshot>({
  id: "structured-duplicate",
  area: "Search & sharing",
  severity: "medium",
  title: "The same structured data is on this page twice",
  what: "A schema.org type is described both in JSON-LD and as microdata (itemtype) on the same page.",
  why: "Search engines see two descriptions of one thing, which can disagree, and may pick the wrong one or ignore both.",
  fix: "Keep one: usually the JSON-LD, and remove the itemscope and itemtype attributes from the theme or plugin that adds microdata.",
  tech: "a schema.org @type in JSON-LD is also a microdata itemtype",
  run(page) {
    const micro = new Set((page.itemTypes ?? []).map(schemaType));
    if (micro.size === 0 || page.jsonLd.length === 0) return [];
    const both = [...jsonLdTypes(page.jsonLd)].filter((t) => micro.has(t)).sort();
    if (both.length === 0) return [];
    return [
      {
        checkId: "structured-duplicate",
        severity: "medium",
        title: this.title,
        evidence: `${both.join(", ")} ${both.length === 1 ? "is" : "are"} in both JSON-LD and microdata`,
        url: page.finalUrl,
      },
    ];
  },
});
