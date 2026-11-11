import { defineCheck } from "../model.js";
import { isGatsbySite } from "../gatsby/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { firstFew } from "./site-helpers.js";

/** Gatsby Cloud's own preview and build hosts: uncited, a name from memory of the hosted product. */
const GATSBY_HOSTS = [".gatsbyjs.io", ".gtsb.io"];

const isPreviewHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return isTemporaryHost(h) || GATSBY_HOSTS.some((s) => h.endsWith(s));
};
const onPreview = (url: string | undefined): boolean => {
  try {
    return url !== undefined && isPreviewHost(new URL(url).hostname);
  } catch {
    return false;
  }
};

export const gatsbyPreviewCanonical = defineCheck<PageSnapshot>({
  id: "gatsby-preview-canonical",
  size: "S",
  done: "The live site builds its canonical and share addresses from the production domain.",
  estimateChanges:
    "A siteUrl set wrong only in some deployments means checking each environment, then rebuilding.",
  area: "Launch day",
  severity: "high",
  title: "The live Gatsby site points search engines at a preview deployment",
  what: "A production page of this Gatsby site gives a preview domain as its canonical address, its og:url or og:image, or in its sitemap.",
  why: "Search engines and social cards follow those addresses to the preview, which can show old content or vanish when the preview is cleaned up.",
  fix: "Set siteMetadata.siteUrl (and the sitemap plugin's site URL) from the production domain in every build, and rebuild.",
  tech: "Gatsby sites served from a non-temporary host: the canonical, og:url, og:image and sitemap entries whose host ends in .vercel.app, .netlify.app, .pages.dev, .gatsbyjs.io or .gtsb.io. The two Gatsby hosts are from memory of the hosted product (uncited)",
  async run(page, ctx) {
    if (!isGatsbySite(page) || isPreviewHost(new URL(page.finalUrl).hostname)) return [];
    const parts: string[] = [];
    if (onPreview(page.canonical)) parts.push(`canonical ${page.canonical ?? ""}`);
    if (onPreview(page.og["og:url"])) parts.push(`og:url ${page.og["og:url"] ?? ""}`);
    if (onPreview(page.og["og:image"])) parts.push(`og:image ${page.og["og:image"] ?? ""}`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) => onPreview(u));
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "gatsby-preview-canonical",
        severity: "high",
        title: this.title,
        evidence: `${parts.join("; ")} ${parts.length === 1 ? "is" : "are"} on a preview domain`,
        url: page.finalUrl,
      },
    ];
  },
});
