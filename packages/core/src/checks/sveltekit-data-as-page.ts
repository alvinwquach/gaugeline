import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSveltekitSite } from "../sveltekit/detect.js";

const isFrameworkAddress = (u: string): boolean => {
  try {
    const p = new URL(u).pathname;
    return p.endsWith("/__data.json") || p.endsWith(".html__data.json");
  } catch {
    return false;
  }
};

export const sveltekitDataAsPage = defineCheck<PageSnapshot>({
  id: "sveltekit-data-as-page",
  size: "M",
  done: "The page address returns HTML, and the sitemap lists pages only.",
  estimateChanges:
    "A proxy or CDN rule that rewrites page addresses to the data address is one change; a sitemap built from the route files may need its own filter.",
  area: "Search & sharing",
  severity: "high",
  title: "A page address returns SvelteKit data, not a page",
  what: 'A page of this SvelteKit site answers with the framework\'s route data (application/json or text/sveltekit-data holding {"type":"data","nodes":...}), or the sitemap lists __data.json addresses.',
  why: "Search engines and visitors get a JSON payload instead of a page, or index the payloads: the page can drop out of search while a browser that navigates inside the app looks fine.",
  fix: "Serve HTML at page addresses (look for a proxy, CDN or adapter rule that rewrites to __data.json), and list only pages in the sitemap.",
  tech: 'SvelteKit sites only, from responses already read: the page\'s own answer with a JSON or text/sveltekit-data content type whose body starts with {"type":"data","nodes"; sitemap entries ending /__data.json or .html__data.json. No extra request',
  async run(page, ctx) {
    const last = page.hops.at(-1);
    const parts: string[] = [];
    const kind = (last?.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const isData =
      (kind === "text/sveltekit-data" || kind === "application/json") &&
      /^\s*\{\s*"type"\s*:\s*"data"\s*,\s*"nodes"/.test((last?.body ?? "").slice(0, 200));
    if (isData) parts.push(`this address answers ${kind} with route data`);
    if (!isData && !isSveltekitSite(page)) return [];
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter(isFrameworkAddress);
    if (listed.length > 0)
      parts.push(
        `the sitemap lists ${listed.length} data address${listed.length === 1 ? "" : "es"}`,
      );
    if (parts.length === 0) return [];
    return [
      {
        checkId: "sveltekit-data-as-page",
        severity: "high",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
