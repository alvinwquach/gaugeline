import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { generatorOf } from "../static-generators/detect.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { firstFew } from "./site-helpers.js";

/** Hosts a generator writes when its base address was never set: Hugo's default is example.org (uncited), Jekyll's server uses localhost. */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "example.org",
  "example.com",
  "example.net",
  "localhost",
  "127.0.0.1",
]);

const bad = (url: string | undefined): boolean => {
  try {
    if (url === undefined) return false;
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return PLACEHOLDERS.has(host) || isTemporaryHost(host);
  } catch {
    return false;
  }
};

export const staticPreviewCanonical = defineCheck<PageSnapshot>({
  id: "static-preview-canonical",
  size: "S",
  done: "The built site's canonical and share addresses use the production domain.",
  estimateChanges:
    "A base address that is right in one build and wrong in another means checking every build setting.",
  area: "Launch day",
  severity: "high",
  title: "The site was built with a placeholder or preview address",
  what: "A page built with a static site generator gives a placeholder (example.org, localhost) or preview domain as its canonical address, its og:url, or in its sitemap.",
  why: "Search engines and social cards follow those addresses away from your site, to a domain that is not yours or a preview that disappears.",
  fix: "Set the site's base address to the production domain (Hugo: baseURL; Jekyll: url; Eleventy: a site url in the data; Docusaurus: url; VitePress: sitemap hostname) and rebuild.",
  tech: "Sites with a Hugo, Jekyll, Eleventy, Docusaurus or VitePress generator tag, served from a non-temporary host: the canonical, og:url and sitemap entries whose host is example.org, example.com, example.net, localhost or 127.0.0.1, or ends in .vercel.app, .netlify.app or .pages.dev (the same list as next-preview-canonical). Hugo's example.org default is uncited",
  async run(page, ctx) {
    if (generatorOf(page) === undefined) return [];
    const host = new URL(page.finalUrl).hostname;
    if (isTemporaryHost(host) || PLACEHOLDERS.has(host.toLowerCase())) return [];
    const parts: string[] = [];
    if (bad(page.canonical)) parts.push(`canonical ${page.canonical ?? ""}`);
    if (bad(page.og["og:url"])) parts.push(`og:url ${page.og["og:url"] ?? ""}`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter(bad);
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "static-preview-canonical",
        severity: "high",
        title: this.title,
        evidence: `${parts.join(", ")} ${parts.length === 1 && listed.length === 0 ? "is" : "are"} on a placeholder or preview domain`,
        url: page.finalUrl,
      },
    ];
  },
});
