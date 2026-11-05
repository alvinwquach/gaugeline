import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { shortUrl } from "./site-helpers.js";

export const linksViaRedirect = defineCheck<PageSnapshot>({
  id: "links-via-redirect",
  area: "Visitors",
  severity: "low",
  title: "Links on this page go through a redirect",
  what: "Links to other pages on the site answer with a redirect (3xx) before reaching the page.",
  why: "Each redirect adds a round trip for visitors, and search engines pass a little less on through every hop.",
  fix: "Change the link to the address it ends up at. This usually follows a move to new URLs, https or www.",
  tech: "a sampled same-site a[href] answers 3xx first and ends in 200",
  async run(page, ctx) {
    const sample = await ctx.links?.();
    if (!sample) return [];
    const origin = new URL(page.finalUrl).origin;
    return sample.taken.flatMap((link) => {
      const first = link.hops[0]?.status;
      const last = link.hops.at(-1);
      if (first === undefined || first < 300 || first >= 400 || last?.status !== 200) return [];
      return [
        {
          checkId: "links-via-redirect",
          severity: "low" as const,
          title: this.title,
          evidence: `${shortUrl(link.href, origin)} (${first}) ends at ${shortUrl(last.url, origin)}`,
          url: link.url,
        },
      ];
    });
  },
});
