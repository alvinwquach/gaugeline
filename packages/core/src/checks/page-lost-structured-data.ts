import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { lostTypes } from "../snapshot/compare.js";
import { comparePages, readPages } from "./page-shared.js";

export const pageLostStructuredData = defineCheck<PageSnapshot>({
  id: "page-lost-structured-data",
  area: "Search & sharing",
  severity: "medium",
  title: "A page lost its structured data since the last run",
  what: "Against the last run saved with --since last, a structured-data type that a page had (Product, Recipe, Event, Article) is no longer there.",
  why: "Search results show rich listings (prices, ratings, dates) only from structured data; when a template or plugin change drops it, the page reads the same and the listing quietly goes plain.",
  fix: "Put the markup back where the template lost it, or list the page under expectedChanges in gaugeline.pages.json when it was removed on purpose.",
  tech: "With --since last only. Types are read from JSON-LD @type and microdata itemtype, with the schema.org prefix dropped. One finding per page, naming every type gone. On a first run: could not check",
  async run(page, ctx) {
    const list = await comparePages(page, ctx);
    if (!list) return [];
    return readPages(list, ctx).flatMap(({ key, url, prev, snap }): Finding[] => {
      const gone = lostTypes(prev, snap);
      if (gone.length === 0) return [];
      return [
        {
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${key} had ${gone.join(", ")} structured data last run; the page has ${snap.types.length > 0 ? `only ${snap.types.join(", ")}` : "none"} now`,
          url,
        },
      ];
    });
  },
});
