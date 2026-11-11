import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { controlLabel, findPagination } from "./listing/pagination.js";

export const paginationUnreachable = defineCheck<PageSnapshot>({
  id: "pagination-unreachable",
  size: "S",
  done: "The page 2 control is a real link and a rel next link is in the head.",
  estimateChanges: "A custom pagination component fixed once covers every list that uses it.",
  area: "Search & sharing",
  severity: "high",
  title: "Page 2 of this list has no address",
  what: "The page shows page numbers or a next or load-more control, and the HTML has no address for page 2: the control only works with JavaScript.",
  why: "Search engines don't click buttons, so everything after the first page of the list is never found, and nobody can link to it.",
  fix: 'Give the control a real link (<a href="/blog?page=2">) and add <link rel="next">, keeping the JavaScript on top if you like.',
  tech: "Read from the HTML as sent: no link rel=next, no a[rel=next], and no same-site link differing from this address only by ?page=N or /page/N, while a button, [role=button] or href-less a says Next or Load more, or a pagination element shows 2. Infinite scroll with no control at all can't be seen and isn't reported",
  run(page) {
    const p = findPagination(page);
    if (!p.controls || p.pages.length > 0) return [];
    const label = controlLabel(page);
    return [
      {
        checkId: "pagination-unreachable",
        severity: "high",
        title: this.title,
        evidence: `${label ? `a "${label}" control` : "page numbers"}, and no address for page 2 in the HTML`,
        url: page.finalUrl,
      },
    ];
  },
});
