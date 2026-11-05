import { pageKey } from "../languages.js";
import { defineCheck } from "../model.js";
import { globToRegex } from "../schema-rules.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const langTwinMissing = defineCheck<PageSnapshot>({
  id: "lang-twin-missing",
  area: "Visitors",
  severity: "medium",
  title: "A language version of this page is missing",
  what: "The page says (through hreflang, the sitemap or your language settings) that it has a version in another language, but that version returns an error or redirects to the homepage.",
  why: "Visitors who switch language land on an error or on the homepage, and search engines drop the alternate from results.",
  fix: "Publish the missing version, or remove it from the page's hreflang links and the sitemap. Pages meant to exist in one language only can be excluded in gaugeline.languages.json.",
  tech: "an expected twin (hreflang, sitemap xhtml:link or the configured prefix, subdomain or parameter) answers 4xx or 5xx, or redirects to / or a language root; at most 5 versions are fetched",
  async run(page, ctx) {
    const group = await ctx.languages?.();
    if (!group) return [];
    const path = new URL(page.finalUrl).pathname;
    if (
      (ctx.languageRules?.exclude ?? []).some(
        (g) =>
          globToRegex(g).test(path) ||
          globToRegex(g).test(pageKey(page.finalUrl, ctx.languageRules).key.replace(/^[^/]*/, "")),
      )
    )
      return [];
    const origin = new URL(page.finalUrl).origin;
    const missing = group.versions.filter((v) => v.missing !== undefined);
    if (missing.length === 0) return [];
    return [
      {
        checkId: "lang-twin-missing",
        severity: "medium",
        title: this.title,
        evidence: `${missing.length} of ${group.versions.length} language versions are missing: ${firstFew(missing.map((v) => `${v.lang} ${shortUrl(v.url, origin)} ${v.missing ?? ""}`))}`,
        url: page.finalUrl,
      },
    ];
  },
});
