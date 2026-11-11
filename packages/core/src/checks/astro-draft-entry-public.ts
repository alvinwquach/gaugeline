import { isAstroSite, pageBody, readIslands } from "../astro/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const astroDraftEntryPublic = defineCheck<PageSnapshot>({
  id: "astro-draft-entry-public",
  size: "S",
  done: "No live page carries an entry whose draft flag is on.",
  estimateChanges:
    "Filtering drafts in one shared helper fixes every page; filtering page by page takes longer.",
  area: "Launch day",
  severity: "medium",
  title: "A live page embeds a content entry marked as a draft",
  what: "An island on this Astro page is handed data with a field named draft set to true: an entry the author marked as not ready.",
  why: "Draft entries are meant to be hidden. When a page or island still receives one, its unfinished text is in the HTML for anyone to read.",
  fix: "Filter drafts out where you read the collection (for example `getCollection('posts', ({ data }) => !data.draft)`), and build the island's props from that filtered list only.",
  tech: "Astro sites only, no extra request: astro-island props in the HTML, a boolean field named draft or isDraft that is true; Astro has no built-in draft field, so this reads the common schema convention. The evidence gives the island and field name, never a value",
  run(page) {
    if (!isAstroSite(page)) return [];
    const { islands } = readIslands(pageBody(page).html);
    const hits = islands.flatMap((i) =>
      i.fields
        .filter((f) => f.isTrue && /(?:^|\.)(?:draft|isDraft)$/.test(f.name))
        .map((f) => `${i.component}.${f.name}`),
    );
    if (hits.length === 0) return [];
    return [
      {
        checkId: "astro-draft-entry-public",
        severity: "medium",
        title: this.title,
        evidence: `${hits.length === 1 ? "a draft flag" : `${hits.length} draft flags`} set to true in island props: ${hits.slice(0, 5).join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
