import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

const NOINDEX = /(^|[\s,:])(noindex|none)(\s*(,|$)|$)/i;

export const noindex = defineCheck<PageSnapshot>({
  id: "noindex",
  area: "Search & sharing",
  severity: "high",
  title: "This page asks search engines not to list it",
  what: "The page has a robots meta tag containing noindex.",
  why: "If that isn't on purpose, the page is invisible in search.",
  fix: "Remove noindex from pages you want found.",
  tech: '<meta name="robots" content="noindex">',
  run(page) {
    const evidence: string[] = [];
    if (page.metaRobots !== undefined && NOINDEX.test(page.metaRobots)) {
      evidence.push(`<meta name="robots" content="${page.metaRobots}">`);
    }
    const header = page.hops.at(-1)?.headers["x-robots-tag"];
    if (header !== undefined && NOINDEX.test(header)) evidence.push(`X-Robots-Tag: ${header}`);
    if (evidence.length === 0) return [];
    return [
      {
        checkId: "noindex",
        severity: "high",
        title: this.title,
        evidence: `${evidence.join(" and ")} on ${page.finalUrl}`,
        url: page.finalUrl,
      },
    ];
  },
});
