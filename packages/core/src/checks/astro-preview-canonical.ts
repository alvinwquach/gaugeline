import { isAstroSite } from "../astro/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { firstFew } from "./site-helpers.js";

const onPreview = (url: string | undefined): boolean => {
  try {
    return url !== undefined && isTemporaryHost(new URL(url).hostname);
  } catch {
    return false;
  }
};

export const astroPreviewCanonical = defineCheck<PageSnapshot>({
  id: "astro-preview-canonical",
  size: "S",
  done: "The live site builds its canonical and share addresses from the production domain.",
  estimateChanges:
    "A site address set wrong only in some deployments means checking each environment, then rebuilding.",
  area: "Launch day",
  severity: "high",
  title: "The live Astro site points search engines at a preview deployment",
  what: "A production page of this Astro site gives a preview domain as its canonical address, its og:url or og:image, or in its sitemap.",
  why: "Search engines and social cards follow those addresses to the preview, which can show old content or vanish when the preview is cleaned up.",
  fix: "Set `site` in astro.config.mjs to the production domain (not the preview address a deployment host gives each build), and rebuild.",
  tech: "Astro sites served from a non-temporary host: the canonical, og:url, og:image and sitemap entries whose host ends in .vercel.app, .netlify.app or .pages.dev",
  async run(page, ctx) {
    if (!isAstroSite(page) || isTemporaryHost(new URL(page.finalUrl).hostname)) return [];
    const parts: string[] = [];
    if (onPreview(page.canonical)) parts.push(`canonical ${page.canonical ?? ""}`);
    if (onPreview(page.og["og:url"])) parts.push(`og:url ${page.og["og:url"] ?? ""}`);
    if (onPreview(page.og["og:image"])) parts.push(`og:image ${page.og["og:image"] ?? ""}`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) => onPreview(u));
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "astro-preview-canonical",
        severity: "high",
        title: this.title,
        evidence: `${parts.join("; ")} ${parts.length === 1 && listed.length === 0 ? "is" : "are"} on a preview domain`,
        url: page.finalUrl,
      },
    ];
  },
});
