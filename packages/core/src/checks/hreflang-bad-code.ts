import { isLanguageTag } from "../languages.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const hreflangBadCode = defineCheck<PageSnapshot>({
  id: "hreflang-bad-code",
  size: "S",
  done: "Every hreflang value is a valid code such as es-US, with an x-default.",
  estimateChanges: "A plugin that writes the codes may need a setting changed.",
  area: "Search & sharing",
  severity: "low",
  title: "Some language codes are not valid",
  what: 'hreflang uses a code that isn\'t a valid language tag (such as "sp" or "es_US"), or a page with three or more languages has no x-default.',
  why: "Search engines ignore an hreflang with an invalid code, and without x-default they guess which version to show everyone else.",
  fix: 'Use BCP 47 codes such as es, es-US or es-419 (a hyphen, not an underscore), and add hreflang="x-default" for the version to show when no language matches.',
  tech: "an hreflang value is not a BCP 47 tag (two-letter languages must be ISO 639-1), or 3+ distinct languages have no x-default",
  run(page) {
    const codes = (page.hreflang ?? []).map((a) => a.hreflang);
    if (codes.length === 0) return [];
    const bad = [...new Set(codes.filter((c) => !isLanguageTag(c)))];
    const langs = new Set(
      codes.filter((c) => c.toLowerCase() !== "x-default").map((c) => c.toLowerCase()),
    );
    const noDefault = langs.size >= 3 && !codes.some((c) => c.toLowerCase() === "x-default");
    if (bad.length === 0 && !noDefault) return [];
    const parts = [
      ...(bad.length > 0
        ? [`not valid language tags: ${bad.map((c) => `"${c}"`).join(", ")}`]
        : []),
      ...(noDefault ? [`${langs.size} languages and no x-default`] : []),
    ];
    return [
      {
        checkId: "hreflang-bad-code",
        severity: "low",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
