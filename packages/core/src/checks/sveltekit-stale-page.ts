import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isSveltekitSite, readBootstrap } from "../sveltekit/detect.js";
import { liveVersion } from "../sveltekit/read.js";
import { isHtmlPage } from "./page.js";

export const sveltekitStalePage = defineCheck<PageSnapshot>({
  id: "sveltekit-stale-page",
  size: "M",
  done: "The page's build version matches the version file of the deployment that served it.",
  estimateChanges:
    "A CDN purge on deploy is one setting; prerendered pages cached with no expiry may need each purged.",
  area: "Launch day",
  severity: "medium",
  title: "The page is from an older build than the site",
  what: "The build version written into this SvelteKit page differs from the one in the site's _app/version.json, so the page is a copy from an earlier deploy.",
  why: "A prerendered or cached page from an old build points at script files that may be gone, and shows old content next to a new site: edits look unpublished.",
  fix: "Purge the CDN's copy of the page on every deploy, or let it expire (a short s-maxage). A prerendered page is rebuilt on each build, so check the cache in front of it.",
  tech: "SvelteKit sites only. The version: in the page's inline __sveltekit_ script against the version of one GET of <appDir>/version.json (the folder is read from the page's own module addresses; the file is public and fetched by every visitor's browser). A page whose version cannot be read, or a version file that is missing, is could not check. Pages sampled together are compared with the same file, asked for once per page",
  async run(page, ctx) {
    if (!ctx.fetcher || !isSveltekitSite(page) || !isHtmlPage(page)) return [];
    const boot = readBootstrap(page);
    if (boot?.version === undefined || boot.dev) {
      if (!boot?.dev)
        ctx.couldNotCheck?.(page.finalUrl, "the page does not carry its build version");
      return [];
    }
    const live = await liveVersion(page, ctx);
    if ("unread" in live) {
      ctx.couldNotCheck?.(live.url ?? page.finalUrl, live.unread);
      return [];
    }
    if (live.version === boot.version) return [];
    return [
      {
        checkId: "sveltekit-stale-page",
        severity: "medium",
        title: this.title,
        evidence: `the page was built as version ${boot.version.slice(0, 40)} and ${new URL(live.url).pathname} says ${live.version.slice(0, 40)}`,
        url: page.finalUrl,
      },
    ];
  },
});
