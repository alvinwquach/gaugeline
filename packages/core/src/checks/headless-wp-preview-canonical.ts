import { defineCheck } from "../model.js";
import { isHeadlessWordPress, isPreviewAddress } from "../headless-wordpress/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { firstFew } from "./site-helpers.js";

const onPreview = (url: string | undefined): boolean => {
  try {
    return url !== undefined && (isTemporaryHost(new URL(url).hostname) || isPreviewAddress(url));
  } catch {
    return false;
  }
};

export const headlessWpPreviewCanonical = defineCheck<PageSnapshot>({
  id: "headless-wp-preview-canonical",
  size: "S",
  done: "The live site's canonical and share addresses are the production page's own address.",
  estimateChanges:
    "The address usually comes from one setting (the WordPress site URL or the front end's base address); each environment needs it checked.",
  area: "Launch day",
  severity: "high",
  title: "The live site points search engines at a preview address",
  what: "A production page of this headless WordPress site gives a preview address as its canonical, its og:url or og:image, or in its sitemap: either a preview deployment (vercel.app, netlify.app, pages.dev) or a WordPress preview link (preview=true, preview_id, previewId).",
  why: "Search engines and social cards follow those addresses to a draft or a deployment that can show old content, ask for a login or vanish.",
  fix: "Build canonical and share addresses from the production domain and the post's permalink, never from the request that rendered the preview; rebuild.",
  tech: "Headless WordPress sites served from a non-temporary host: the canonical, og:url, og:image and sitemap entries whose host ends in .vercel.app, .netlify.app or .pages.dev, or whose query has preview=true, preview_id or previewId. From responses already read; no extra request",
  async run(page, ctx) {
    if (!isHeadlessWordPress(page) || isTemporaryHost(new URL(page.finalUrl).hostname)) return [];
    const parts: string[] = [];
    if (onPreview(page.canonical)) parts.push(`canonical ${page.canonical ?? ""}`);
    if (onPreview(page.og["og:url"])) parts.push(`og:url ${page.og["og:url"] ?? ""}`);
    if (onPreview(page.og["og:image"])) parts.push(`og:image ${page.og["og:image"] ?? ""}`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) => onPreview(u));
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "headless-wp-preview-canonical",
        severity: "high",
        title: this.title,
        evidence: `${parts.join("; ")} ${parts.length === 1 && listed.length === 0 ? "is" : "are"} a preview address`,
        url: page.finalUrl,
      },
    ];
  },
});
