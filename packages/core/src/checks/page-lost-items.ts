import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { lostItems } from "../snapshot/compare.js";
import { comparePages, readPages } from "./page-shared.js";

export const pageLostItems = defineCheck<PageSnapshot>({
  id: "page-lost-items",
  area: "Visitors",
  severity: "medium",
  title: "A listing has fewer items than last run",
  what: "Against the last run saved with --since last, a repeated list on a page (products, posts, people, events) has fewer items, with the ones that are gone where items carry links.",
  why: "A shop page with 7 products instead of 12 still looks complete: items drop out when a feed, a filter or a category breaks, and nobody counts.",
  fix: "Check the items that are gone were removed on purpose. If they weren't, look at what feeds the list. A listing meant to shrink goes under expectedChanges in gaugeline.pages.json.",
  tech: "With --since last only. A list is a ul or ol with 3 or more items, or an element marked data-list, in the main content; it is named by its data-list value or the heading before it. For a paginated list only the first page is compared, and the evidence says so. On a first run: could not check",
  async run(page, ctx) {
    const list = await comparePages(page, ctx);
    if (!list) return [];
    return readPages(list, ctx).flatMap(({ url, prev, snap }): Finding[] =>
      lostItems(prev, snap).map((evidence) => ({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence,
        url,
      })),
    );
  },
});
