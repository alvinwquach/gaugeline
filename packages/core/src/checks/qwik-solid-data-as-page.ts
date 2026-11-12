import { isQDataAddress, looksLikeQData } from "../qwik/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { frameworkOf } from "./qwik-solid-shared.js";

const isServerAddress = (u: string): boolean => {
  try {
    return /^\/_server(?:\/|$)/.test(new URL(u).pathname);
  } catch {
    return false;
  }
};

export const qwikSolidDataAsPage = defineCheck<PageSnapshot>({
  id: "qwik-solid-data-as-page",
  size: "M",
  done: "The page address returns HTML, and the sitemap lists pages only.",
  estimateChanges:
    "A proxy or CDN rule that rewrites page addresses to the data address is one change; a sitemap built from the route files may need its own filter.",
  area: "Search & sharing",
  severity: "high",
  title: "A page address returns Qwik City data, not a page",
  what: "A page of this Qwik or SolidStart site answers with the framework's route data (Qwik City's q-data.json payload), or the sitemap lists q-data.json or /_server addresses.",
  why: "Search engines and visitors get a JSON payload instead of a page, or index the payloads: the page can drop out of search while a browser that navigates inside the app looks fine.",
  fix: "Serve HTML at page addresses (look for a proxy, CDN or adapter rule that rewrites to q-data.json), and list only pages in the sitemap.",
  tech: 'Qwik and SolidStart sites, from responses already read: the page\'s own answer with a JSON content type whose body starts {"_entry":"..","_objs": (Qwik City\'s q-data format); sitemap entries ending /q-data.json or starting /_server. No extra request',
  async run(page, ctx) {
    const last = page.hops.at(-1);
    const kind = (last?.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const isData = /json/.test(kind) && looksLikeQData(last?.body ?? "");
    if (!isData && frameworkOf(page) === undefined) return [];
    const parts: string[] = [];
    if (isData) parts.push(`this address answers ${kind} with route data`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter(
      (u) => isQDataAddress(u) || isServerAddress(u),
    );
    if (listed.length > 0)
      parts.push(
        `the sitemap lists ${listed.length} data address${listed.length === 1 ? "" : "es"}`,
      );
    if (parts.length === 0) return [];
    return [
      {
        checkId: "qwik-solid-data-as-page",
        severity: "high",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
