import { defineCheck } from "../model.js";
import { dedupeUrls } from "../sample.js";
import { probe } from "../site-context.js";
import type { PageSnapshot } from "../snapshot.js";
import { finalStatus, firstFew, shortUrl } from "./site-helpers.js";

/** www.tea.example and tea.example are one site. */
function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export const llmsTxtBrokenLinks = defineCheck<PageSnapshot>({
  id: "llms-txt-broken-links",
  area: "Search & sharing",
  severity: "medium",
  title: "Your llms.txt sends assistants to pages that don't work",
  what: "Links in /llms.txt return an error (4xx or 5xx) or redirect to a different site.",
  why: "llms.txt is a short guide for AI assistants to your most useful pages. A dead or off-site link is the page they quote, or fail to.",
  fix: "Update the links to the pages' current addresses, or remove the ones that no longer exist.",
  tech: "links in /llms.txt answer 4xx or 5xx, or redirect off-site",
  async run(page, ctx) {
    const site = await ctx.site?.();
    const file = site?.llms.file;
    if (!site || !file || !ctx.fetcher || !ctx.budget) return [];
    const fetcher = ctx.fetcher;
    const links = dedupeUrls(
      file.sections.flatMap((s) => s.links.map((l) => l.url)),
      site.llms.url,
    ).filter((u) => /^https?:/.test(u));
    const sample = ctx.budget.take("llmsTxtLinks", links);
    const hops = await Promise.all(sample.map((u) => probe(fetcher, u)));
    const origin = new URL(page.finalUrl).origin;
    const bad = sample.flatMap((url, i) => {
      const h = hops[i] ?? [];
      const status = finalStatus(h);
      if (status !== undefined && status >= 400) return [`${shortUrl(url, origin)} (${status})`];
      const last = h.at(-1)?.url;
      if (h.length > 1 && last && siteOf(last) !== siteOf(url)) {
        return [`${shortUrl(url, origin)} (redirects to ${last})`];
      }
      return [];
    });
    if (bad.length === 0) return [];
    return [
      {
        checkId: "llms-txt-broken-links",
        severity: "medium",
        title: this.title,
        evidence: `${bad.length} of ${sample.length} links in llms.txt do not work: ${firstFew(bad)}`,
        url: site.llms.url,
      },
    ];
  },
});
