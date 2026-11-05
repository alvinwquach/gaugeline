import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findStega, jsonStrings } from "./sharing/stega.js";

export const stegaLeak = defineCheck<PageSnapshot>({
  id: "stega-leak",
  area: "Search & sharing",
  severity: "high",
  title: "Hidden editing characters leaked onto the live site",
  what: "The title, a meta tag or the structured data contains invisible characters: Unicode tag characters or long runs of zero-width characters, the kind a CMS preview (such as Sanity's stega) adds.",
  why: "They are invisible to you but not to everyone else: search results, share previews and copied text carry them, and they can break string comparisons and structured data.",
  fix: "Turn stega encoding off for production builds (in Sanity, set stega: false outside preview) and strip it from fields that end up in metadata.",
  tech: "a code point in U+E0000 to U+E007F, or 4 or more zero-width characters in a row, in the title, meta content or JSON-LD strings",
  run(page) {
    const places: string[] = [];
    if (page.rawText?.title !== undefined && findStega(page.rawText.title))
      places.push("the title");
    const meta = (page.rawText?.meta ?? []).filter((m) => findStega(m)).length;
    if (meta > 0) places.push(`${meta} meta ${meta === 1 ? "tag" : "tags"}`);
    const ld = jsonStrings(page.jsonLd).filter((s) => findStega(s)).length;
    if (ld > 0) places.push(`${ld} structured data ${ld === 1 ? "value" : "values"}`);
    if (places.length === 0) return [];
    return [
      {
        checkId: "stega-leak",
        severity: "high",
        title: this.title,
        evidence: `hidden characters in ${places.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
