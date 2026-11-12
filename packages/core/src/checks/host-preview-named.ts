import { isTemporaryHost } from "./launch/hosts.js";
import { defineCheck } from "../model.js";
import { frameworkCoversPreviewCanonical } from "../framework-coverage.js";
import { describePreview, hostAndPath, previewMentions } from "../host-previews.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

export const hostPreviewNamed = defineCheck<PageSnapshot>({
  id: "host-preview-named",
  size: "S",
  done: "No page, sitemap or feed of the live site names a preview or deploy address any more.",
  estimateChanges:
    "An address built from a host-provided variable is one setting; one pasted into content or a CMS is a search through both.",
  area: "Launch day",
  severity: "high",
  title: "The live site names a preview address",
  what: "A page, the sitemap or a feed of the live site gives a Vercel, Netlify, Cloudflare Pages or Amplify preview or deploy address as its canonical, og:url, a language version, a script or an entry.",
  why: "Search engines and feed readers follow those addresses to a copy of the site that can show old content, can be indexed next to the real one, and disappears when the host cleans up the preview.",
  fix: "Build absolute addresses from the live domain, not from the host's per-deploy variable (VERCEL_URL, DEPLOY_PRIME_URL, CF_PAGES_URL, AWS_BRANCH) and rebuild; then search the CMS content for the old name.",
  tech: "On a page not served from a .vercel.app, .netlify.app, .pages.dev or .amplifyapp.com host: canonical, og:url, hreflang, script src, feed links, the sitemap's entries and alternates and the feed items whose host has the shape of a preview address (deploy-preview-<n>--site, <branch>--site, <hash>.project.pages.dev, pr-<n>.<app id>.amplifyapp.com, project-git-<branch>-team and project-<hash>-team .vercel.app). Nothing is requested; links are left to temp-host-links, and the canonical, og:url and sitemap entries on a .vercel.app, .netlify.app or .pages.dev host of a Next.js, Astro, SvelteKit, Angular, Gatsby, Hydrogen or static-generator site to that framework's own preview-canonical check",
  async run(page, ctx) {
    if (isTemporaryHost(new URL(page.finalUrl).hostname)) return [];
    const site = await ctx.site?.();
    const found = previewMentions(page, site, {
      skipCovered: frameworkCoversPreviewCanonical(page),
    });
    if (found.length === 0) return [];
    const shown = found.map((m) => `${m.where} ${hostAndPath(m.url)}`);
    const kinds = [...new Set(found.map((m) => describePreview(m.address)))].sort();
    return [
      {
        checkId: "host-preview-named",
        severity: "high",
        title: this.title,
        evidence: `${found.length} place${found.length === 1 ? " names" : "s name"} a preview address (${kinds.join(", ")}): ${firstFew(shown)}`,
        url: page.finalUrl,
      },
    ];
  },
});
