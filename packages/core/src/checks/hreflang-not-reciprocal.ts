import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

export const hreflangNotReciprocal = defineCheck<PageSnapshot>({
  id: "hreflang-not-reciprocal",
  size: "M",
  done: "Every language version carries the same full set of hreflang links, including one to itself.",
  estimateChanges: "The number of language versions and whether the links come from one component.",
  area: "Search & sharing",
  severity: "medium",
  title: "A language version doesn't link back",
  what: "This page's hreflang points at a version in another language, but that version's hreflang doesn't point back.",
  why: "Search engines ignore hreflang pairs that aren't confirmed from both sides, so searchers may get the wrong language.",
  fix: "Give every version the same full set of hreflang links, including one to itself.",
  tech: "page A has <link rel=alternate hreflang> to B, and B (fetched) has none to A (a trailing slash is not a difference)",
  async run(page, ctx) {
    const own = page.hreflang ?? [];
    if (own.length === 0) return [];
    const group = await ctx.languages?.();
    const origin = new URL(page.finalUrl).origin;
    const back = (group?.versions ?? []).filter((v) => {
      if (!v.page || !own.some((a) => same(new URL(a.href, page.finalUrl).href, v.url)))
        return false;
      return !(v.page.hreflang ?? []).some((a) =>
        same(new URL(a.href, v.page?.finalUrl ?? v.url).href, page.finalUrl),
      );
    });
    if (back.length === 0) return [];
    return [
      {
        checkId: "hreflang-not-reciprocal",
        severity: "medium",
        title: this.title,
        evidence: `${shortUrl(page.finalUrl, origin)} points to ${firstFew(back.map((v) => `${v.lang} ${shortUrl(v.url, origin)}`))}, which ${back.length === 1 ? "does" : "do"} not point back`,
        url: page.finalUrl,
      },
    ];
  },
});
