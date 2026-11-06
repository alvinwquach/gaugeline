import { isHidden } from "../hidden.js";
import { defineCheck } from "../model.js";
import { getOrNull } from "../probe.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { hiddenLinks } from "./hidden/common.js";
import { firstFew, shortUrl } from "./site-helpers.js";

const NOINDEX = /\b(?:noindex|none)\b/i;

export const hiddenIndexable = defineCheck<PageSnapshot>({
  id: "hidden-indexable",
  area: "Launch day",
  severity: "high",
  title: "An unlaunched page can be indexed",
  what: "An address in a hidden section, found in the sitemap or through a link, answers 200 with no noindex and no login.",
  why: "Anyone who finds it can read it, and search engines can list it before launch.",
  fix: "Send noindex (X-Robots-Tag or a robots meta tag) on the hidden section until launch, or put it behind a login.",
  tech: "Hidden addresses from the sitemaps and from hiddenLinks, at most 5, fetched once with GET for the status, X-Robots-Tag and meta robots only (nothing else of the page is read); 401, 403, 404 or a redirect out of the section is a pass",
  async run(page, ctx) {
    const config = ctx.hidden;
    if (!config || !ctx.fetcher || !ctx.budget) return [];
    const site = page.finalUrl;
    const fromSitemap = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) =>
      isHidden(config, u, site),
    );
    const fromLinks = (await hiddenLinks(page, ctx)).map((l) => l.target);
    const candidates = [
      ...new Set([...fromSitemap, ...fromLinks].map((u) => new URL(u, site).href)),
    ];
    const open: string[] = [];
    for (const url of ctx.budget.take("hiddenPages", candidates)) {
      const hops = await getOrNull(ctx.fetcher, url);
      const last = hops.at(-1);
      if (!last || last.status !== 200 || !isHidden(config, last.url, site)) continue;
      if (NOINDEX.test(last.headers["x-robots-tag"] ?? "")) continue;
      if (NOINDEX.test(buildSnapshot(hops).metaRobots ?? "")) continue;
      open.push(url);
    }
    if (open.length === 0) return [];
    const origin = new URL(site).origin;
    const paths = open.map((u) => shortUrl(u, origin));
    return [
      {
        checkId: "hidden-indexable",
        severity: "high",
        title: this.title,
        evidence:
          paths.length === 1
            ? `${paths[0] ?? ""} answers 200 with no noindex and no login`
            : `${paths.length} hidden addresses answer 200 with no noindex and no login: ${firstFew(paths)}`,
        url: site,
      },
    ];
  },
});
