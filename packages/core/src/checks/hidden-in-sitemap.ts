import { isHidden } from "../hidden.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const hiddenInSitemap = defineCheck<PageSnapshot>({
  id: "hidden-in-sitemap",
  area: "Launch day",
  severity: "high",
  title: "Unlaunched pages are in your sitemap",
  what: "The sitemap lists addresses in a section gaugeline.hidden.json says is hidden until launch.",
  why: "The sitemap is the list you hand to search engines: they will crawl and index the section before anyone meant it to be public.",
  fix: "Leave the hidden section out of the sitemap until launch, usually a filter on the same flag that hides the pages.",
  tech: "Every address listed by the sitemaps read (robots.txt's, /sitemap.xml, one level of sitemap index), matched against the hidden path globs",
  async run(page, ctx) {
    const config = ctx.hidden;
    if (!config) return [];
    const origin = new URL(page.finalUrl).origin;
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) =>
      isHidden(config, u, page.finalUrl),
    );
    if (listed.length === 0) return [];
    const n = listed.length;
    return [
      {
        checkId: "hidden-in-sitemap",
        severity: "high",
        title: this.title,
        evidence: `${n} hidden address${n === 1 ? "" : "es"} in the sitemap: ${firstFew(listed.map((u) => shortUrl(u, origin)))}`,
        url: page.finalUrl,
      },
    ];
  },
});
