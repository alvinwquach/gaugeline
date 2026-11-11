import { classifyHop, describeRefusal } from "../refusal.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus, firstFew, shortUrl } from "./site-helpers.js";

export const sitemapDead = defineCheck<PageSnapshot>({
  id: "sitemap-dead",
  size: "S",
  done: "Every address in the sitemap loads.",
  estimateChanges:
    "A generated sitemap fed by deleted CMS entries is fixed at the source. A hand-edited one is edited by hand.",
  area: "Search & sharing",
  severity: "high",
  title: "Your sitemap lists pages that don't exist",
  what: "Pages listed in the sitemap return an error (4xx or 5xx).",
  why: "The sitemap is where you tell search engines which pages matter. Dead entries waste their visits and make them trust the sitemap less.",
  fix: "Remove the dead addresses from the sitemap, or restore the pages. A generated sitemap usually means a deleted page is still in the CMS or the route list.",
  tech: "sampled sitemap entries return 4xx or 5xx; a refusal (401, 403, 429, 503 with Retry-After) is listed as could not check",
  async run(page, ctx) {
    const site = await ctx.site?.();
    if (!site) return [];
    const origin = new URL(page.finalUrl).origin;
    const dead = site.sitemapSample.flatMap((hops, i) => {
      const status = finalStatus(hops);
      const url = site.sitemapUrls[i] ?? "";
      const outcome = classifyHop(hops.at(-1));
      if (outcome.kind === "refused") {
        ctx.couldNotCheck?.(url, describeRefusal(outcome));
        return [];
      }
      return status !== undefined && status >= 400 ? [{ url, status }] : [];
    });
    if (dead.length === 0) return [];
    return [
      {
        checkId: "sitemap-dead",
        severity: "high",
        title: this.title,
        evidence: `${dead.length} of ${site.sitemapSample.length} sampled sitemap entries return an error: ${firstFew(dead.map((d) => `${shortUrl(d.url, origin)} (${d.status})`))}`,
        url: dead[0]?.url ?? page.finalUrl,
      },
    ];
  },
});
