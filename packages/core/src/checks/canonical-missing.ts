import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

export const canonicalMissing = defineCheck<PageSnapshot>({
  id: "canonical-missing",
  area: "Search & sharing",
  severity: "low",
  title: "The page doesn't say which address is the real one",
  what: "There's no canonical tag.",
  why: "Copies of the page with tracking parameters can be treated as separate pages.",
  fix: "Add a self-referencing canonical tag.",
  tech: 'no <link rel="canonical">',
  run(page) {
    if (!isHtmlPage(page) || page.canonicals.length > 0) return [];
    return [
      {
        checkId: "canonical-missing",
        severity: "low",
        title: this.title,
        evidence: `no <link rel="canonical"> on ${page.finalUrl}`,
        url: page.finalUrl,
      },
    ];
  },
});
