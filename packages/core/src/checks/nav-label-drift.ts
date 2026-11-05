import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { collectNav, contentIndex, normaliseLabel } from "./content/parse.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const navLabelDrift = defineCheck<PageSnapshot>({
  id: "nav-label-drift",
  area: "Visitors",
  severity: "low",
  title: "One page has two names in your menus",
  what: "The same link appears in the menu, header or footer with two different labels.",
  why: "Visitors wonder whether the two labels are two pages, and the site reads as unfinished.",
  fix: "Use one label for each page everywhere. Menus kept in two places (a header and a footer component) drift apart first.",
  tech: "one href (a #fragment makes a different destination) has more than one distinct label across nav, header and footer (case and trailing arrows ignored)",
  run(page) {
    const origin = new URL(page.finalUrl).origin;
    const drift: string[] = [];
    for (const [href, labels] of collectNav(contentIndex(page))) {
      const distinct = new Map<string, string>();
      for (const l of labels)
        if (!distinct.has(normaliseLabel(l))) distinct.set(normaliseLabel(l), l);
      if (distinct.size > 1)
        drift.push(
          `${shortUrl(href, origin)} is ${[...distinct.values()].map((l) => `"${l}"`).join(" and ")}`,
        );
    }
    if (drift.length === 0) return [];
    return [
      {
        checkId: "nav-label-drift",
        severity: "low",
        title: this.title,
        evidence: `${drift.length} ${drift.length === 1 ? "link has" : "links have"} two labels: ${firstFew(drift)}`,
        url: page.finalUrl,
      },
    ];
  },
});
