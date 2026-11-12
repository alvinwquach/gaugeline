import { defineCheck } from "../model.js";
import { isNuxtFrameworkUrl } from "../nuxt/framework-urls.js";
import { isNuxtSite } from "../nuxt/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

export const nuxtFrameworkFileListed = defineCheck<PageSnapshot>({
  id: "nuxt-framework-file-listed",
  size: "S",
  done: "The sitemap, the canonical and the language alternates name pages only, never a _payload.json or a /_nuxt/ file.",
  estimateChanges:
    "A sitemap built by a module needs its exclude setting; a canonical built from the request path needs the payload suffix stripped.",
  area: "Search & sharing",
  severity: "medium",
  title: "A Nuxt data file is named as a page",
  what: "The sitemap, the canonical address, og:url or an hreflang alternate of this Nuxt site names a framework file (a _payload.json, a /_nuxt/ build file or a /__nuxt_island/ component) as if it were a page.",
  why: "Search engines then crawl and may index a JSON payload instead of the page, and the page's real address loses its signals.",
  fix: "Keep payload and build addresses out of the sitemap (exclude _payload.json and /_nuxt/), and build the canonical from the page's route path, not from the address of the request that fetched its payload.",
  tech: "Nuxt sites only: canonical, og:url, hreflang hrefs and sitemap entries whose path starts /_nuxt/, /__nuxt_island/ or /__nuxt_devtools__, or ends /_payload.json or /_payload.js. Read from the page and the sitemap already fetched; nothing extra is requested. Paths are compared as written, so a site under a base URL prefix is matched only on the suffix",
  async run(page, ctx) {
    if (!isNuxtSite(page)) return [];
    const parts: string[] = [];
    for (const [label, url] of [
      ["canonical", page.canonical],
      ["og:url", page.og["og:url"]],
    ] as const)
      if (url !== undefined && isNuxtFrameworkUrl(url)) parts.push(`${label} ${url}`);
    const alternates = (page.hreflang ?? []).map((a) => a.href).filter(isNuxtFrameworkUrl);
    if (alternates.length > 0) parts.push(`hreflang ${firstFew([...new Set(alternates)])}`);
    const listed = (await ctx.site?.())?.sitemapFrameworkUrls ?? [];
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "nuxt-framework-file-listed",
        severity: "medium",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
