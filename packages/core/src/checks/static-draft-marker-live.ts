import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  cutShort,
  draftMarker,
  generatorOf,
  isIndexable,
  normalizePath,
} from "../static-generators/detect.js";
import { isHtmlPage } from "./page.js";

export const staticDraftMarkerLive = defineCheck<PageSnapshot>({
  id: "static-draft-marker-live",
  size: "S",
  done: "Draft pages are left out of the live build, so no page that says it is a draft is public.",
  estimateChanges:
    "Drafts built by a deploy preview and by the main build are two settings to change.",
  area: "Launch day",
  severity: "high",
  title: "A page that says it is a draft is live",
  what: "This page, built with a static site generator, shows a draft marker and is open to search engines or listed in the sitemap.",
  why: "Drafts are work nobody approved. A draft in the sitemap is handed to search engines to list, and a visitor can read it.",
  fix: "Build the live site without drafts (Hugo: drop --buildDrafts; Jekyll: drop --drafts; Docusaurus and VitePress: set the page's draft or unlisted option and rebuild), or finish the page and remove the marker.",
  tech: 'Sites with a Hugo, Jekyll, Eleventy, Docusaurus or VitePress generator tag only: a class name "draft", "is-draft", "post-draft", "draft-badge", "badge-draft", the Docusaurus theme-draft-banner or theme-unlisted-banner on the page (class names only, never text), and no noindex, or an address the sitemaps list. The badge class names are theme conventions (uncited); the Docusaurus banners are from @docusaurus/theme-common 3.10.2',
  async run(page, ctx) {
    if (!isHtmlPage(page) || generatorOf(page) === undefined) return [];
    if (cutShort(page)) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "the page was cut short, so its markers were not read in full",
      );
      return [];
    }
    const marker = draftMarker(page);
    if (!marker) return [];
    const reasons: string[] = [];
    if (isIndexable(page)) reasons.push("search engines may index it");
    const origin = new URL(page.finalUrl).origin;
    const here = normalizePath(page.finalUrl, origin);
    const listed = ((await ctx.site?.())?.sitemapUrls ?? []).some(
      (u) => normalizePath(u, origin) === here,
    );
    if (listed) reasons.push("the sitemap lists it");
    if (reasons.length === 0) return [];
    return [
      {
        checkId: "static-draft-marker-live",
        severity: "high",
        title: this.title,
        evidence: `marked as ${marker.kind === "draft" ? "a draft" : "unlisted"} (${marker.marker}) and ${reasons.join(" and ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
