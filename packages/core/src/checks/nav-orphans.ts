import { defineCheck } from "../model.js";
import { inboundLinks, orphans } from "../nav/graph.js";
import type { PageSnapshot } from "../snapshot.js";
import { navOf } from "./nav-shared.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const navOrphans = defineCheck<PageSnapshot>({
  id: "nav-orphans",
  size: "S",
  done: "Each page in the sitemap has a link from its section or a related page, or is out of the sitemap.",
  estimateChanges: "Many orphans from one section are one menu change.",
  area: "Visitors",
  severity: "medium",
  title: "Pages in the sitemap that no page links to",
  what: "Addresses the sitemap lists that none of the pages read link to, in their menus, footers or text.",
  why: "Visitors can only reach them from search or an old bookmark, and search engines treat a page nothing links to as unimportant.",
  fix: "Link to each page from its section's menu or a related page, or take it out of the sitemap if it is gone.",
  tech: "With --since last or a gaugeline.nav.json (it reads the run's other pages). Same-site sitemap addresses (one level of index) against every link on the checked page and the run's other pages (4); the checked page itself is excepted. A page linked only from a page not read is reported too: the evidence says how many were read",
  async run(page, ctx) {
    // Reads the run's other pages (more requests): only when the run tracks its menu.
    if (!ctx.navRules && !ctx.baselineRequested) return [];
    const site = await ctx.site?.();
    const listed = site?.sitemapUrls ?? [];
    if (listed.length === 0) return [];
    const pages = (await ctx.pages?.()) ?? [page];
    const lonely = orphans(
      listed,
      inboundLinks(pages.map((p) => navOf(p, ctx.navRules))),
      page.finalUrl,
    );
    if (lonely.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    return [
      {
        checkId: "nav-orphans",
        severity: "medium",
        title: this.title,
        evidence: `${lonely.length} sitemap address${lonely.length === 1 ? " has" : "es have"} no link from the ${pages.length} page${pages.length === 1 ? "" : "s"} read: ${firstFew(lonely.map((u) => shortUrl(u, origin)))}`,
        url: page.finalUrl,
      },
    ];
  },
});
