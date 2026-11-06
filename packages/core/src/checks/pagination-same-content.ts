import { defineCheck } from "../model.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import { findPagination, mainTextFingerprint } from "./listing/pagination.js";
import { shortUrl } from "./site-helpers.js";

/** Page 2 and page 3 at most: the question is whether later pages exist and differ. */
const EXTRA_PAGES = 2;

export const paginationSameContent = defineCheck<PageSnapshot>({
  id: "pagination-same-content",
  area: "Search & sharing",
  severity: "high",
  title: "Page 2 of this list shows page 1 again",
  what: "A later page of the list answers, and its main text is identical to the first page's.",
  why: "The page parameter is ignored, so every older item is unreachable for visitors and search engines, and the copies count as duplicate pages.",
  fix: "Make the list read the page number (often a query parameter the framework drops, or a cache that ignores the query string).",
  tech: "At most 2 later pages (from findPagination), fetched with GET inside the links budget; the main text (no header, nav, footer, script or style), whitespace collapsed, hashed with SHA-256, equals page 1's. A later page that answers 4xx/5xx is broken-links' to report",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget) return [];
    const fetcher = ctx.fetcher;
    const later = ctx.budget.take("links", findPagination(page).pages.slice(0, EXTRA_PAGES));
    if (later.length === 0) return [];
    const first = mainTextFingerprint(page.hops.at(-1)?.body ?? "");
    const origin = new URL(page.finalUrl).origin;
    const same: string[] = [];
    for (const url of later) {
      const last = (await getOrNull(fetcher, url)).at(-1);
      if (last?.status === 200 && mainTextFingerprint(last.body ?? "") === first) same.push(url);
    }
    return same.slice(0, 1).map((url) => ({
      checkId: "pagination-same-content",
      severity: "high" as const,
      title: this.title,
      evidence: `${shortUrl(url, origin)} shows the same list as ${shortUrl(page.finalUrl, origin)}`,
      url: page.finalUrl,
    }));
  },
});
