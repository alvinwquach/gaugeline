import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

/** The scaffold's rule: replace it, and the TODO text below, before this can merge. */
const SCAFFOLD_TITLE = "Failing page for copy-date-passed";

export const copyDatePassed = defineCheck<PageSnapshot>({
  id: "copy-date-passed",
  area: "Visitors",
  severity: "medium",
  title: "A promotion or notice on the page has a date that has already passed",
  what: "TODO: what this check catches, in one sentence.",
  why: "TODO: why it matters to whoever owns the site.",
  fix: "TODO: how to fix it.",
  tech: "TODO: the technical line for whoever fixes it",
  size: "S",
  done: "TODO: what fixed looks like, as Gaugeline would see it when it runs again.",
  estimateChanges: "TODO: what makes this fix smaller or bigger than its size says.",
  run(page) {
    if (page.title !== SCAFFOLD_TITLE) return [];
    return [
      {
        checkId: "copy-date-passed",
        severity: "medium",
        title: this.title,
        evidence: `title is "${page.title}" on ${page.finalUrl}`,
        url: page.finalUrl,
      },
    ];
  },
});
