import { defineCheck } from "../model.js";
import { isHeadlessWordPress, isPreviewAddress } from "../headless-wordpress/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

const onPreview = (url: string | undefined): boolean => {
  try {
    return url !== undefined && isPreviewAddress(url);
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
  title: "The live site points search engines at a WordPress preview link",
  what: "A production page of this headless WordPress site gives a WordPress preview link (a query with preview=true, preview_id or previewId) as its canonical, its og:url or og:image, or in its sitemap.",
  why: "Search engines and social cards follow that address to a draft, which asks for a login or shows content nobody approved. A preview deployment (vercel.app, netlify.app) used as the canonical is reported by the framework's own check (next-preview-canonical on Next.js).",
  fix: "Build canonical and share addresses from the production domain and the post's permalink, never from the request that rendered the preview; rebuild.",
  tech: "Headless WordPress sites: the canonical, og:url, og:image and sitemap entries whose query has preview=true, preview_id or previewId (WordPress's preview link, and Faust.js's, read from the @faustwp/core source: preview=true; preview_id and previewId are uncited). Preview deployment hosts are left to the framework's own check. From responses already read; no extra request",
  async run(page, ctx) {
    if (!isHeadlessWordPress(page)) return [];
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
        evidence: `${parts.join("; ")} ${parts.length === 1 && listed.length === 0 ? "is" : "are"} a preview link`,
        url: page.finalUrl,
      },
    ];
  },
});
