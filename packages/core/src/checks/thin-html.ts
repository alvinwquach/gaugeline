import { NEXT_RENDERED_NOTE, isNextSite } from "../next/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** From the catalogue: fewer than 60 words outside the header, nav and footer. */
export const THIN_HTML_MIN_WORDS = 60;

export const thinHtml = defineCheck<PageSnapshot>({
  id: "thin-html",
  area: "Search & sharing",
  severity: "high",
  title: "Google sees an almost empty page",
  what: "Fewer than 60 words exist in the page before JavaScript runs, outside the header, nav and footer.",
  why: "Many crawlers and AI tools read the page without running JavaScript, so they see almost nothing.",
  fix: "Render the main content on the server. In Next.js, keep it out of client-only components and Suspense boundaries that wait for the browser.",
  tech: "word count of server-rendered HTML",
  run(page) {
    if (!isHtmlPage(page) || page.contentWordCount >= THIN_HTML_MIN_WORDS) return [];
    return [
      {
        checkId: "thin-html",
        severity: "high",
        title: this.title,
        evidence: `${page.contentWordCount} words in the server-rendered HTML outside header, nav and footer (fewer than ${THIN_HTML_MIN_WORDS})${isNextSite(page) ? `. ${NEXT_RENDERED_NOTE}` : ""}`,
        url: page.finalUrl,
      },
    ];
  },
});
