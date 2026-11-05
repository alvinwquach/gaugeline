import { defineCheck } from "../model.js";
import { probe } from "../probe.js";
import { isSameSite, sampleUrls } from "../sample.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus, shortUrl } from "./site-helpers.js";
import { collectUrls } from "./structured/collect.js";

export const jsonld404 = defineCheck<PageSnapshot>({
  id: "jsonld-404",
  area: "Search & sharing",
  severity: "high",
  title: "Structured data points at pages that don't exist",
  what: "Addresses on the site named in the page's structured data (a product URL, an image, a logo) return an error.",
  why: "Search engines use these addresses for rich results. A dead product or image address can drop the rich result entirely.",
  fix: "Update the structured data to the current addresses. Generated structured data usually means a stale CMS field or a renamed route.",
  tech: "same-site http(s) strings inside JSON-LD answer 4xx or 5xx; at most 12 are requested, the first 12 in document order",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || page.jsonLd.length === 0) return [];
    const fetcher = ctx.fetcher;
    const urls = collectUrls(page.jsonLd)
      .filter((u) => isSameSite(u, page.finalUrl))
      .map((url) => ({ url }));
    const unique = sampleUrls(urls, Number.MAX_SAFE_INTEGER).taken.map((t) => t.url);
    const taken = ctx.budget.take("structuredDataAddresses", unique);
    const hops = await Promise.all(taken.map((u) => probe(u, fetcher)));
    const origin = new URL(page.finalUrl).origin;
    return taken.flatMap((url, i) => {
      const status = finalStatus(hops[i] ?? []);
      if (status === undefined || status < 400) return [];
      return [
        {
          checkId: "jsonld-404",
          severity: "high" as const,
          title: this.title,
          evidence: `structured data names ${shortUrl(url, origin)}, which returned ${status}`,
          url,
        },
      ];
    });
  },
});
