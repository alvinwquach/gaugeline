import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus, firstFew, shortUrl } from "./site-helpers.js";

export const sitemapRedirects = defineCheck<PageSnapshot>({
  id: "sitemap-redirects",
  size: "S",
  done: "Each sitemap entry is the address its page redirects to.",
  estimateChanges:
    "A move to https, www or a new URL scheme changes every entry at once, and the sitemap is regenerated.",
  area: "Search & sharing",
  severity: "medium",
  title: "Your sitemap lists old addresses that redirect",
  what: "Pages listed in the sitemap answer with a redirect (3xx) instead of the page.",
  why: "A sitemap should list the final address of each page. Redirecting entries make search engines do extra work and can keep the old address in results.",
  fix: "List each page at the address it redirects to. This often follows a move to https, to www, or to a new URL scheme.",
  tech: "sampled sitemap entries return 3xx",
  async run(page, ctx) {
    const site = await ctx.site?.();
    if (!site) return [];
    const origin = new URL(page.finalUrl).origin;
    const moved = site.sitemapSample.flatMap((hops, i) => {
      const first = hops[0]?.status;
      const last = finalStatus(hops);
      // An entry that ends in an error is sitemap-dead's finding, not this one.
      if (first === undefined || first < 300 || first >= 400) return [];
      if (last !== undefined && last >= 400) return [];
      return [{ url: site.sitemapUrls[i] ?? "", status: first, to: hops.at(-1)?.url ?? "" }];
    });
    if (moved.length === 0) return [];
    return [
      {
        checkId: "sitemap-redirects",
        severity: "medium",
        title: this.title,
        evidence: `${moved.length} of ${site.sitemapSample.length} sampled sitemap entries redirect: ${firstFew(moved.map((m) => `${shortUrl(m.url, origin)} (${m.status} to ${shortUrl(m.to, origin)})`))}`,
        url: moved[0]?.url ?? page.finalUrl,
      },
    ];
  },
});
