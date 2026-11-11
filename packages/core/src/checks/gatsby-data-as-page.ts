import { defineCheck } from "../model.js";
import { isGatsbySite, isPageDataAddress } from "../gatsby/detect.js";
import type { PageSnapshot } from "../snapshot.js";

export const gatsbyDataAsPage = defineCheck<PageSnapshot>({
  id: "gatsby-data-as-page",
  size: "M",
  done: "The page address returns HTML, and the sitemap lists pages only.",
  estimateChanges:
    "A proxy or CDN rule that rewrites page addresses to the data file is one change; a sitemap built from every file under public may need its own filter.",
  area: "Search & sharing",
  severity: "high",
  title: "A page address returns Gatsby data, not a page",
  what: "A page of this Gatsby site answers with the framework's page data (application/json starting with componentChunkName), or the sitemap lists page-data addresses.",
  why: "Search engines and visitors get a JSON file instead of a page, or index the data files: the page can drop out of search while a browser that navigates inside the site looks fine.",
  fix: "Serve HTML at page addresses (look for a proxy, CDN or redirect rule that rewrites to page-data.json), and list only pages in the sitemap.",
  tech: 'Gatsby sites only, from responses already read: the page\'s own answer with a JSON content type whose body starts {"componentChunkName"; sitemap entries under /page-data/ ending /page-data.json, /app-data.json or /sq/d/<hash>.json. No extra request',
  async run(page, ctx) {
    const last = page.hops.at(-1);
    const parts: string[] = [];
    const kind = (last?.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const isData =
      kind.includes("json") &&
      /^\s*\{\s*"componentChunkName"/.test((last?.body ?? "").slice(0, 200));
    if (isData) parts.push(`this address answers ${kind} with page data`);
    if (!isData && !isGatsbySite(page)) return [];
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter(isPageDataAddress);
    if (listed.length > 0)
      parts.push(
        `the sitemap lists ${listed.length} page-data address${listed.length === 1 ? "" : "es"}`,
      );
    if (parts.length === 0) return [];
    return [
      {
        checkId: "gatsby-data-as-page",
        severity: "high",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
