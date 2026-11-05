import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const sitemapMissing = defineCheck<PageSnapshot>({
  id: "sitemap-missing",
  area: "Search & sharing",
  severity: "medium",
  title: "Search engines can't find a list of your pages",
  what: "There is no sitemap at /sitemap.xml, and robots.txt does not say where one is.",
  why: "Without a sitemap, search engines find pages only by following links, so new or deep pages take longer to appear.",
  fix: "Publish a sitemap at /sitemap.xml (most site builders and frameworks can generate one) and add a Sitemap: line with its full address to robots.txt.",
  tech: "/sitemap.xml is not a 200 sitemap and robots.txt has no Sitemap: line",
  async run(page, ctx) {
    const site = await ctx.site?.();
    // robots.txt did not answer: it may name a sitemap, so nothing can be said.
    if (!site || site.robotsState === "unknown") return [];
    if ((site.robots?.sitemaps.length ?? 0) > 0) return [];
    const fallback = site.sitemaps[0];
    if (!fallback || fallback.status === null) return [];
    if (fallback.status === 200 && fallback.kind !== "unknown") return [];
    const what =
      fallback.status === 200
        ? "returned 200 but is not a sitemap (no urlset or sitemapindex)"
        : `returned ${fallback.status}`;
    return [
      {
        checkId: "sitemap-missing",
        severity: "medium",
        title: this.title,
        evidence: `${fallback.url} ${what}; ${site.robotsState === "found" ? "robots.txt has no Sitemap: line" : "there is no robots.txt"}`,
        url: page.finalUrl,
      },
    ];
  },
});
