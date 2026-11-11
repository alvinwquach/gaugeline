import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { contentIndex, normaliseLabel } from "./content/parse.js";
import { PLACEHOLDER_TITLES } from "./content/lists.js";
import { isHtmlPage } from "./page.js";
import { firstFew } from "./site-helpers.js";

const LOREM = /\blorem ipsum\b/gi;
const TODO = /\b(?:TODO|TBD|FIXME)\b/g;
const BRACKETED =
  /\[(?:insert|add|your|placeholder|name|title|todo|tbd|company|headline|text|copy)\b[^\]]{0,40}\]/gi;

export const placeholderText = defineCheck<PageSnapshot>({
  id: "placeholder-text",
  size: "S",
  done: "The placeholder is replaced with the real copy.",
  estimateChanges: "Copy that has not been written is the real cost.",
  area: "Visitors",
  severity: "medium",
  title: "The page still has placeholder text",
  what: "The page shows unfinished copy: lorem ipsum, TODO or TBD, a [bracketed placeholder], or a title or main heading such as Untitled, Staging or Test.",
  why: "Visitors see an unfinished site, and search engines may show the placeholder in results.",
  fix: 'Replace the placeholder with the real copy. Search the CMS for "lorem", "TODO" and "[" before publishing.',
  tech: `main content text matches "lorem ipsum", TODO/TBD/FIXME or [insert ...]-style brackets (code and pre ignored), or the whole title or h1 is one of ${PLACEHOLDER_TITLES.map((t) => `"${t}"`).join(", ")} (English lists)`,
  run(page) {
    if (!isHtmlPage(page)) return [];
    const { mainText, titles, h1s } = contentIndex(page);
    const found: string[] = [];
    for (const re of [LOREM, TODO, BRACKETED])
      for (const m of mainText.matchAll(re)) found.push(`"${m[0]}"`);
    const whole = new Set(PLACEHOLDER_TITLES);
    for (const t of titles.slice(0, 1))
      if (whole.has(normaliseLabel(t))) found.push(`title "${t}"`);
    for (const h of h1s) if (whole.has(normaliseLabel(h))) found.push(`h1 "${h}"`);
    if (found.length === 0) return [];
    return [
      {
        checkId: "placeholder-text",
        severity: "medium",
        title: this.title,
        evidence: `${found.length} placeholder${found.length === 1 ? "" : "s"}: ${firstFew(found)}`,
        url: page.finalUrl,
      },
    ];
  },
});
