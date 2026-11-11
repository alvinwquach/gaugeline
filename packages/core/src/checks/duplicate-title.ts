import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { contentIndex } from "./content/parse.js";
import { isHtmlPage } from "./page.js";

export const duplicateTitle = defineCheck<PageSnapshot>({
  id: "duplicate-title",
  size: "S",
  done: "The page's head holds one title tag.",
  estimateChanges:
    "The extra title often comes from a plugin or a theme, and removing a plugin can change other pages.",
  area: "Search & sharing",
  severity: "high",
  title: "This page has two titles",
  what: "The HTML has more than one title element (titles inside SVG images do not count).",
  why: "Search engines pick one, not always the one you meant, so the result shows the wrong title. It usually means two SEO components both render one.",
  fix: "Keep one <title> in the head. Remove the one a theme, plugin or layout adds on top of your SEO component.",
  tech: "more than one <title> element outside <svg>",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const { titles } = contentIndex(page);
    if (titles.length < 2) return [];
    return [
      {
        checkId: "duplicate-title",
        severity: "high",
        title: this.title,
        evidence: `${titles.length} title elements: ${titles
          .slice(0, 3)
          .map((t) => `"${t}"`)
          .join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
