import { isTemporaryHost } from "./launch/hosts.js";
import { defineCheck } from "../model.js";
import { frameworkCoversPreviewCanonical } from "../framework-coverage.js";
import { hostAndPath, previewMentions, saysNoindex } from "../host-previews.js";
import { getOrNull } from "../probe.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

/** The address to ask for: the one named, without its query or fragment (a token in it is never sent). */
function asked(url: string): string[] {
  try {
    const u = new URL(url.startsWith("//") ? `https:${url}` : url);
    return [`${u.protocol}//${u.host}${u.pathname}`];
  } catch {
    return [];
  }
}

/** Preview addresses asked about per checked page: each is one GET, never more. */
const MAX_ASKED = 3;

export const hostPreviewIndexable = defineCheck<PageSnapshot>({
  id: "host-preview-indexable",
  size: "S",
  done: "Every preview address the live site names answers with a login, noindex, or nothing at all.",
  estimateChanges:
    "A host setting is quick; a preview that is already indexed also needs removal requests in Search Console.",
  area: "Launch day",
  severity: "high",
  title: "A preview of the site can be found by search engines",
  what: "A Vercel, Netlify, Cloudflare Pages or Amplify preview or deploy address that the live site names answers with a page and does not ask search engines to stay away.",
  why: "Search engines can index the preview next to the real site, with old prices, test content or a duplicate of every page competing with yours.",
  fix: "Turn on the host's deployment protection for previews (Vercel Authentication, Netlify password protection, Cloudflare Access, Amplify access control) or send X-Robots-Tag: noindex on every preview page, and stop the live site naming the address.",
  tech: "One GET of each preview address (at most 3 per page) that the page, the sitemap or a feed names, no address guessed (the canonical, og:url and sitemap entries on a .vercel.app, .netlify.app or .pages.dev host of a Next.js, Astro, SvelteKit, Angular, Gatsby, Hydrogen or static-generator page are left to that framework's own preview-canonical check): a final 200 on a preview host with no noindex or none in meta robots or X-Robots-Tag and a canonical that is missing or its own. A 401 or 403 is protected, a canonical elsewhere is consolidated and a redirect away is fine; no answer or a cut-off body is reported as could not check",
  async run(page, ctx) {
    if (!ctx.fetcher || isTemporaryHost(new URL(page.finalUrl).hostname)) return [];
    const site = await ctx.site?.();
    const urls = [
      ...new Set(
        previewMentions(page, site, {
          links: true,
          skipCovered: frameworkCoversPreviewCanonical(page),
        })
          .filter((m) => !["script", "feed link"].includes(m.where))
          .flatMap((m) => asked(m.url)),
      ),
    ].slice(0, MAX_ASKED);
    const open: string[] = [];
    for (const url of urls) {
      const hops = await getOrNull(ctx.fetcher, url);
      const last = hops.at(-1);
      if (!last) {
        ctx.couldNotCheck?.(url, `${hostAndPath(url)} did not answer`);
        continue;
      }
      const host = new URL(url).hostname;
      if (last.status !== 200 || new URL(last.url).hostname !== host) continue;
      if (saysNoindex(last.headers["x-robots-tag"])) continue;
      const read = buildSnapshot(hops);
      if (saysNoindex(read.metaRobots)) continue;
      if (last.truncated) {
        ctx.couldNotCheck?.(
          url,
          `${hostAndPath(url)} is larger than the part read, so its meta tags were not all seen`,
        );
        continue;
      }
      const own = read.canonicals.every((c) => {
        try {
          return new URL(c, last.url).hostname === host;
        } catch {
          return false;
        }
      });
      if (!own) continue;
      open.push(hostAndPath(url));
    }
    if (open.length === 0) return [];
    return [
      {
        checkId: "host-preview-indexable",
        severity: "high",
        title: this.title,
        evidence: `${firstFew(open)} ${open.length === 1 ? "answers" : "answer"} 200 with no noindex in meta robots or X-Robots-Tag and no canonical elsewhere`,
        url: page.finalUrl,
      },
    ];
  },
});
