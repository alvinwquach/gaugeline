import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export const sitemapHost = defineCheck<PageSnapshot>({
  id: "sitemap-host",
  size: "S",
  done: "The sitemap lists pages on the site's public address.",
  estimateChanges: "A site URL setting is one line. A hand-written sitemap is edited by hand.",
  area: "Search & sharing",
  severity: "medium",
  title: "Your sitemap lists pages on a different address",
  what: "Every entry in the sitemap uses a different host than the site, for example a staging domain or the other of www and the bare domain.",
  why: "Search engines ignore sitemap entries for a host the sitemap does not belong to, so the sitemap does nothing for this site.",
  fix: "Generate the sitemap with the site's public address. In most frameworks this is a site URL or base URL setting.",
  tech: "every sitemap entry's host differs from the page's host",
  async run(page, ctx) {
    const site = await ctx.site?.();
    if (!site || site.sitemapUrls.length === 0) return [];
    const host = new URL(page.finalUrl).host;
    const hosts = site.sitemapUrls.map(hostOf);
    if (hosts.some((h) => h === host)) return [];
    const others = [...new Set(hosts.filter((h): h is string => h !== undefined))];
    return [
      {
        checkId: "sitemap-host",
        severity: "medium",
        title: this.title,
        evidence: `all ${site.sitemapUrls.length} sitemap entries use ${firstFew(others)}; the site is ${host}`,
        url: site.sitemaps[0]?.url ?? page.finalUrl,
      },
    ];
  },
});
