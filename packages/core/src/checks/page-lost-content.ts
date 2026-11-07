import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { lostContent } from "../snapshot/compare.js";
import { comparePages, readPages } from "./page-shared.js";

export const pageLostContent = defineCheck<PageSnapshot>({
  id: "page-lost-content",
  area: "Visitors",
  severity: "high",
  title: "A page lost content since the last run",
  what: "Against the last run saved with --since last, a page's main content fell by more than 40%, or a whole section (a heading and everything under it) is gone.",
  why: "The page still loads, so nothing else notices: a template change, a failed import or an editor's mistake can empty a page that visitors and search engines relied on.",
  fix: "Restore what went missing, or list the page under expectedChanges in gaugeline.pages.json with the reason when the loss was meant.",
  tech: "With --since last only. Words are counted in the main content (main, else body) with the header, footer, navigation and asides left out, so a menu change doesn't count. A section is an h2 or h3; a heading gone is a section gone. Exactly 40% fewer words is not a loss. On a first run: could not check",
  async run(page, ctx) {
    const list = await comparePages(page, ctx);
    if (!list) return [];
    return readPages(list, ctx).flatMap(({ url, prev, snap }): Finding[] => {
      const evidence = lostContent(prev, snap);
      return evidence
        ? [{ checkId: this.id, severity: this.severity, title: this.title, evidence, url }]
        : [];
    });
  },
});
