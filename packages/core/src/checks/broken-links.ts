import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus, shortUrl } from "./site-helpers.js";

/**
 * Statuses that are not a broken link: 401 and 403 mean "not for you", 429 means "not now". They
 * are handed to the outcome rule (G12e), not reported as broken.
 */
export const NOT_BROKEN: ReadonlySet<number> = new Set([401, 403, 429]);

export const brokenLinks = defineCheck<PageSnapshot>({
  id: "broken-links",
  area: "Visitors",
  severity: "high",
  title: "Links on this page go nowhere",
  what: "Links to other pages on the site return an error (404, 410 or 5xx).",
  why: "Visitors who click hit a dead end, and search engines take broken links as a sign the site is neglected.",
  fix: "Point each link at the page's current address, or remove it. When a page moved, add a 301 redirect from the old address.",
  tech: 'a sampled same-site a[href] ends in 4xx (not 401, 403 or 429) or 5xx. A 200 page that says "not found" (a soft 404) is out of scope',
  async run(page, ctx) {
    const sample = await ctx.links?.();
    if (!sample) return [];
    const origin = new URL(page.finalUrl).origin;
    return sample.taken.flatMap((link) => {
      const status = finalStatus(link.hops);
      if (status === undefined || status < 400 || NOT_BROKEN.has(status)) return [];
      const text = link.text ? `"${link.text}" ` : "";
      return [
        {
          checkId: "broken-links",
          severity: "high" as const,
          title: this.title,
          evidence: `${text}<a href="${shortUrl(link.href, origin)}"> returned ${status}`,
          url: link.url,
        },
      ];
    });
  },
});
