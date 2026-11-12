import type { Hop } from "../fetcher.js";
import { isHydrogenSite, isPreviewHost, onPreviewHost } from "../hydrogen/detect.js";
import { defineCheck, type Finding } from "../model.js";
import { getOrNull } from "../probe.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";

const NOINDEX = /(^|[\s,:])(noindex|none)(\s*(,|$)|$)/i;

/** What a preview address tells search engines: "open" (200 page, no noindex), "closed", or undefined (no page to judge). */
function indexability(hops: readonly Hop[]): "open" | "closed" | undefined {
  const last = hops.at(-1);
  if (!last || last.status !== 200 || last.truncated === true) return undefined;
  if (!/html/i.test(last.headers["content-type"] ?? "")) return undefined;
  if (NOINDEX.test(last.headers["x-robots-tag"] ?? "")) return "closed";
  const meta = buildSnapshot([...hops]).metaRobots;
  return meta !== undefined && NOINDEX.test(meta) ? "closed" : "open";
}

export const hydrogenPreviewIndexable = defineCheck<PageSnapshot>({
  id: "hydrogen-preview-indexable",
  size: "M",
  done: "Every preview deployment answers with noindex (X-Robots-Tag or a robots meta tag) or asks for a sign-in.",
  estimateChanges:
    "Previews on several Oxygen environments or on another host each need the header; a shared link can be turned off in the deployment's Share settings.",
  area: "Launch day",
  severity: "high",
  title: "A Hydrogen preview deployment can be found by search engines",
  what: "A preview deployment of this Hydrogen storefront (an Oxygen preview address, or another temporary host) answers with a public page that carries no noindex, in a header or a robots meta tag.",
  why: "A preview shows work in progress, old prices and products that are not for sale. Once a search engine finds its address (from a link on the live site, a sitemap or a share) it can list it beside, or instead of, the real store.",
  fix: "Send `X-Robots-Tag: noindex` from every non-production deployment (check the environment in the server entry), serve a disallow-all robots.txt there, take the preview's address out of the live site's links and sitemap, and turn off the deployment's shared link when it is not needed.",
  tech: "Hydrogen storefronts. Only addresses the site itself reveals are asked for, with one GET each and at most the run's hiddenPages budget: the page's own address when it is on a preview host, and links and sitemap entries (the canonical and og:url are reported by hydrogen-preview-canonical and not asked for) of a production page whose host ends in myshopify.dev, o2.myshopify.dev, vercel.app, netlify.app or pages.dev. A 200 HTML answer without noindex is a finding; a sign-in redirect, 401, 403 or 404 is not (Shopify documents that only signed-in staff can open a deployment until a shared link is made). No other path is asked for. The two myshopify.dev suffixes are the owner's note and not confirmed in Shopify's documentation (uncited)",
  async run(page, ctx) {
    if (!isHydrogenSite(page)) return [];
    const here = new URL(page.finalUrl);
    const out: Finding[] = [];
    const finding = (address: string, via: string): void => {
      out.push({
        checkId: "hydrogen-preview-indexable",
        severity: "high",
        title: this.title,
        evidence: `${address} answers 200 with no noindex (${via})`,
        url: page.finalUrl,
      });
    };
    if (isPreviewHost(here.hostname)) {
      if (indexability(page.hops) === "open") finding(page.finalUrl, "this is the page checked");
      return out;
    }
    if (!ctx.fetcher || !ctx.budget) return [];
    const revealed = new Map<string, string>();
    const note = (url: string | undefined, via: string): void => {
      if (url === undefined || !onPreviewHost(url)) return;
      const u = new URL(url);
      if (!revealed.has(u.origin)) revealed.set(u.origin, via);
    };
    for (const l of page.links) note(l.href, "linked from this page");
    for (const u of (await ctx.site?.())?.sitemapUrls ?? []) note(u, "listed in the sitemap");
    for (const origin of ctx.budget.take("hiddenPages", [...revealed.keys()])) {
      const hops = await getOrNull(ctx.fetcher, `${origin}/`);
      if (hops.length === 0) {
        ctx.couldNotCheck?.(origin, "the preview address did not answer");
        continue;
      }
      if (indexability(hops) === "open") finding(origin, revealed.get(origin) ?? "linked");
    }
    return out;
  },
});
