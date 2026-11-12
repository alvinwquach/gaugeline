import { isHydrogenSite, isPreviewHost, onPreviewHost } from "../hydrogen/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

export const hydrogenPreviewCanonical = defineCheck<PageSnapshot>({
  id: "hydrogen-preview-canonical",
  size: "S",
  done: "The live storefront builds its canonical and share addresses from the production domain.",
  estimateChanges:
    "A variable that is wrong only in some Oxygen environments means checking each one, then redeploying.",
  area: "Launch day",
  severity: "high",
  title: "The live Hydrogen store points search engines at a preview deployment",
  what: "A production page of this Hydrogen storefront gives an Oxygen preview or other temporary address as its canonical, its og:url or og:image, or in its sitemap.",
  why: "Search engines and social cards follow those addresses to the preview, which can show old products and prices or vanish when the preview is deleted.",
  fix: "Build the storefront's base address from the production domain (an environment variable set per Oxygen environment, or the request's own origin), and redeploy.",
  tech: "Hydrogen storefronts (the powered-by: Shopify, Hydrogen header) served from a non-preview host: the canonical, og:url, og:image and sitemap entries whose host ends in myshopify.dev, o2.myshopify.dev, vercel.app, netlify.app or pages.dev. The two myshopify.dev suffixes are the owner's note, not confirmed in Shopify's documentation (uncited)",
  async run(page, ctx) {
    if (!isHydrogenSite(page) || isPreviewHost(new URL(page.finalUrl).hostname)) return [];
    const parts: string[] = [];
    if (onPreviewHost(page.canonical)) parts.push(`canonical ${page.canonical ?? ""}`);
    if (onPreviewHost(page.og["og:url"])) parts.push(`og:url ${page.og["og:url"] ?? ""}`);
    if (onPreviewHost(page.og["og:image"])) parts.push(`og:image ${page.og["og:image"] ?? ""}`);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).filter((u) => onPreviewHost(u));
    if (listed.length > 0) parts.push(`the sitemap lists ${firstFew(listed)}`);
    if (parts.length === 0) return [];
    return [
      {
        checkId: "hydrogen-preview-canonical",
        severity: "high",
        title: this.title,
        evidence: `${parts.join("; ")} ${parts.length === 1 && listed.length === 0 ? "is" : "are"} on a preview domain`,
        url: page.finalUrl,
      },
    ];
  },
});
