import { defineCheck } from "../model.js";
import { isDataAddress, isRemixSite } from "../remix/detect.js";
import type { PageSnapshot } from "../snapshot.js";

export const remixDataAsPage = defineCheck<PageSnapshot>({
  id: "remix-data-as-page",
  size: "M",
  done: "The page address returns HTML, and the sitemap and canonical name pages only.",
  estimateChanges:
    "A proxy or CDN rule that rewrites page addresses to the data address is one change; a sitemap built from the route list may need its own filter.",
  area: "Search & sharing",
  severity: "high",
  title: "A page address returns Remix data, not a page",
  what: "A page of this Remix or React Router site answers with the framework's route data (a single-fetch .data payload or a ?_data= answer), or the sitemap or the canonical names a .data or ?_data= address.",
  why: "Search engines and visitors get a data payload instead of a page, or index the payloads: the page can drop out of search while a browser that navigates inside the app looks fine.",
  fix: "Serve HTML at page addresses (look for a proxy, CDN or server rule that rewrites to .data or keeps the ?_data= query), and list only pages in the sitemap and canonical.",
  tech: "Remix and React Router sites. From responses already read, no extra request: the page's own answer with content type text/x-script or the header X-Remix-Response (the framework sets both on every data answer), sitemap entries ending .data or carrying a _data query, and a canonical that does. The markers are in react-router 7.18.5 (lib/server-runtime/single-fetch.ts) and @remix-run/server-runtime 2.17.5 (server.ts), read from npm",
  async run(page, ctx) {
    const last = page.hops.at(-1);
    const kind = (last?.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const parts: string[] = [];
    if (kind === "text/x-script" || last?.headers["x-remix-response"] !== undefined)
      parts.push(
        kind === "text/x-script"
          ? "this address answers text/x-script (single fetch data)"
          : "this address answers with X-Remix-Response, the header of a data answer",
      );
    if (parts.length === 0 && !isRemixSite(page)) return [];
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter(isDataAddress);
    if (listed.length > 0)
      parts.push(
        `the sitemap lists ${listed.length} data address${listed.length === 1 ? "" : "es"}`,
      );
    if (page.canonical !== undefined && isDataAddress(page.canonical))
      parts.push("the canonical is a data address");
    if (parts.length === 0) return [];
    return [
      {
        checkId: "remix-data-as-page",
        severity: "high",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
