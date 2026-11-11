import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

export const viewport = defineCheck<PageSnapshot>({
  id: "viewport",
  size: "S",
  done: "The page head has a viewport meta tag.",
  estimateChanges:
    "A template shared by every page is one edit. Pages built with different templates are one each.",
  area: "Visitors",
  severity: "medium",
  title: "This page isn't set up for phone screens",
  what: "The page has no viewport meta tag, so phones show it zoomed out as if on a desktop screen.",
  why: "Visitors have to pinch and zoom to read anything, and Google treats the page as not mobile-friendly.",
  fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page\'s head.',
  tech: 'no <meta name="viewport"> anywhere in the document',
  run(page) {
    if (!isHtmlPage(page) || page.viewport !== undefined) return [];
    return [
      {
        checkId: "viewport",
        severity: "medium",
        title: this.title,
        evidence: `no <meta name="viewport"> on ${page.finalUrl}`,
        url: page.finalUrl,
      },
    ];
  },
});
