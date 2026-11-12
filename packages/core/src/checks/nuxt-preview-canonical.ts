import { defineCheck } from "../model.js";
import { isNuxtSite } from "../nuxt/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { firstFew } from "./site-helpers.js";

/** A host that is not the live site: a hosting provider's preview domain, or the developer's own machine. */
function isPreviewHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return isTemporaryHost(h) || h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1";
}

const onPreview = (url: string | undefined): boolean => {
  try {
    return url !== undefined && isPreviewHost(new URL(url).hostname);
  } catch {
    return false;
  }
};

export const nuxtPreviewCanonical = defineCheck<PageSnapshot>({
  id: "nuxt-preview-canonical",
  size: "S",
  done: "The live site builds its canonical, share and language addresses from the production domain.",
  estimateChanges:
    "A site address set wrong only in some deployments means checking each environment, then rebuilding. A language module that builds its alternates from its own base address (baseUrl in @nuxtjs/i18n) is one setting.",
  area: "Launch day",
  severity: "high",
  title: "The live Nuxt site points search engines at a preview or local address",
  what: "A production page of this Nuxt site gives a preview deployment or a local address as its canonical address, its og:url or og:image, one of its hreflang alternates, or in its sitemap.",
  why: "Search engines and social cards follow those addresses to the preview, which can show old content or vanish when the preview is cleaned up, and the language versions of the page are tied to the wrong site.",
  fix: "Build the site's base address from the production domain (site config, runtimeConfig.public, or the language module's baseUrl, often set only for preview builds), and rebuild.",
  tech: "Nuxt sites served from a host that is not a temporary one: the canonical, og:url, og:image, hreflang alternates and sitemap entries whose host ends in .vercel.app, .netlify.app or .pages.dev, or is localhost or 127.0.0.1",
  async run(page, ctx) {
    if (!isNuxtSite(page)) return [];
    if (isPreviewHost(new URL(page.finalUrl).hostname)) return [];
    const parts: string[] = [];
    if (onPreview(page.canonical)) parts.push(`canonical ${page.canonical ?? ""}`);
    if (onPreview(page.og["og:url"])) parts.push(`og:url ${page.og["og:url"] ?? ""}`);
    if (onPreview(page.og["og:image"])) parts.push(`og:image ${page.og["og:image"] ?? ""}`);
    const alternates = (page.hreflang ?? []).filter((a) => onPreview(a.href)).map((a) => a.href);
    if (alternates.length > 0)
      parts.push(`hreflang alternates ${firstFew([...new Set(alternates)])}`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) => onPreview(u));
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "nuxt-preview-canonical",
        severity: "high",
        title: this.title,
        evidence: `${parts.join("; ")} ${parts.length === 1 && listed.length === 0 && alternates.length === 0 ? "is" : "are"} on a preview or local address`,
        url: page.finalUrl,
      },
    ];
  },
});
