import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

export const ogImageMissing = defineCheck<PageSnapshot>({
  id: "og-image-missing",
  area: "Search & sharing",
  severity: "low",
  title: "Shared links have no picture",
  what: "The page has no og:image tag.",
  why: "When the page is shared in a chat or a social post, it shows as a plain link with no picture, which fewer people click.",
  fix: 'Add <meta property="og:image" content="https://..."> with a 1200 by 630 picture for the page.',
  tech: "no og:image (or og:image:url) meta property",
  run(page) {
    if (!isHtmlPage(page) || page.og["og:image"] || page.og["og:image:url"]) return [];
    return [
      {
        checkId: "og-image-missing",
        severity: "low",
        title: this.title,
        evidence: `no og:image on ${page.finalUrl}`,
        url: page.finalUrl,
      },
    ];
  },
});
