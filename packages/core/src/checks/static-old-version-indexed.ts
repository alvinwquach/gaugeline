import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { cutShort, isIndexable, versionBanner } from "../static-generators/detect.js";
import { isHtmlPage } from "./page.js";

const samePage = (canonical: string | undefined, page: PageSnapshot): boolean => {
  if (canonical === undefined || canonical === "") return true;
  try {
    const a = new URL(canonical, page.finalUrl);
    const b = new URL(page.finalUrl);
    return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch {
    return true;
  }
};

export const staticOldVersionIndexed = defineCheck<PageSnapshot>({
  id: "static-old-version-indexed",
  size: "M",
  done: "Old documentation versions are marked noindex or point their canonical at the current page.",
  estimateChanges:
    "Docusaurus sets noindex per version (noIndex: true in the docs plugin), and each old version needs it.",
  area: "Search & sharing",
  severity: "medium",
  title: "An old version of the docs is open to search engines",
  what: "This Docusaurus page says its version is no longer maintained (or unreleased), and search engines may list it as it is.",
  why: "Search sends people to old instructions, prices or steps that no longer apply, and the old and new pages compete for the same searches.",
  fix: "Set noIndex: true for the old version in the docs plugin's options, or give its pages a canonical address that points at the current version, and rebuild.",
  tech: "Docusaurus pages only: the theme's theme-doc-version-banner with its no longer actively maintained or unreleased documentation text (@docusaurus/theme-classic and theme-translations 3.10.2), no noindex in the robots meta tag or X-Robots-Tag, and a canonical that is missing or is the page itself. The version name is read from the docusaurus_version meta tag. VitePress has no versioning feature, so its version folders are not judged",
  run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    if (cutShort(page)) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "the page was cut short, so its banner was not read in full",
      );
      return [];
    }
    const banner = versionBanner(page);
    if (!banner || !isIndexable(page) || !samePage(page.canonical, page)) return [];
    return [
      {
        checkId: "static-old-version-indexed",
        severity: "medium",
        title: this.title,
        evidence: `version ${banner.version ?? "(unnamed)"} is ${banner.kind === "unmaintained" ? "no longer actively maintained" : "unreleased"} and is open to search engines`,
        url: page.finalUrl,
      },
    ];
  },
});
