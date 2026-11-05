import { defineCheck } from "../model.js";
import { compareAddresses } from "../normalise.js";
import type { PageSnapshot } from "../snapshot.js";

export const ogUrlMismatch = defineCheck<PageSnapshot>({
  id: "og-url-mismatch",
  area: "Search & sharing",
  severity: "medium",
  title: "Shared links point at a different page than search engines see",
  what: "The page's og:url (the address social apps use when it is shared) differs from its canonical tag.",
  why: "Likes and shares are counted against one address while search engines rank another, and a share can open the wrong page.",
  fix: "Set og:url to the same address as the canonical tag. Both usually come from one SEO component.",
  tech: 'og:url and <link rel="canonical"> differ by scheme, host, path or query (a trailing slash is not a difference)',
  run(page) {
    const og = page.og["og:url"]?.trim();
    if (!og || !page.canonical) return [];
    let resolved: string;
    try {
      resolved = new URL(og, page.finalUrl).href;
    } catch {
      return [];
    }
    const cmp = compareAddresses(resolved, page.canonical);
    if (cmp.same) return [];
    return [
      {
        checkId: "og-url-mismatch",
        severity: "medium",
        title: this.title,
        evidence: `og:url is ${og}; the canonical is ${page.canonical} (differs by ${cmp.differsBy.join(", ")})`,
        url: page.finalUrl,
      },
    ];
  },
});
