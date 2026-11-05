import { defineCheck } from "../model.js";
import { compareAddresses } from "../normalise.js";
import type { PageSnapshot } from "../snapshot.js";

export const canonicalElsewhere = defineCheck<PageSnapshot>({
  id: "canonical-elsewhere",
  area: "Search & sharing",
  severity: "high",
  title: "This page tells Google to show a different page",
  what: "The page's canonical tag names a different address as the real one.",
  why: "Search engines treat the page as a copy, so it may never appear in results.",
  fix: "Give each page a canonical tag that points at its own address. Shared SEO components are the usual cause.",
  tech: '<link rel="canonical"> on the page points at another URL',
  run(page) {
    const distinct = [...new Set(page.canonicals)];
    for (const canonical of distinct) {
      // A trailing slash is not a different page; a scheme, host, path or query is.
      // A canonical that drops the page's own tracking query is correct.
      const cmp = compareAddresses(canonical, page.finalUrl, { query: "ignore" });
      const canonicalQuery = new URL(canonical).search;
      const differsBy =
        cmp.same === false
          ? cmp.differsBy
          : canonicalQuery !== "" && canonicalQuery !== new URL(page.finalUrl).search
            ? (["query"] as const)
            : [];
      if (differsBy.length === 0) continue;
      const also =
        distinct.length > 1 ? `; the page has ${distinct.length} canonical tags that disagree` : "";
      return [
        {
          checkId: "canonical-elsewhere",
          severity: "high",
          title: this.title,
          evidence: `<link rel="canonical" href="${canonical}"> on ${page.finalUrl} (differs by ${differsBy.join(", ")})${also}`,
          url: page.finalUrl,
        },
      ];
    }
    return [];
  },
});
