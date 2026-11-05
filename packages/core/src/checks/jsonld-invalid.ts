import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const jsonldInvalid = defineCheck<PageSnapshot>({
  id: "jsonld-invalid",
  area: "Search & sharing",
  severity: "high",
  title: "This page's structured data is broken",
  what: 'A structured data block (script type="application/ld+json") is not valid JSON.',
  why: "Search engines ignore the whole block, so prices, reviews, FAQs or opening hours in it never reach the results.",
  fix: "Fix the JSON in that block: usually a trailing comma, an unescaped quote or a template that printed nothing. Paste it into a JSON validator to find the line.",
  tech: 'JSON.parse fails on a script type="application/ld+json" block (one finding per block)',
  run(page) {
    return page.jsonLdErrors.map((error) => ({
      checkId: "jsonld-invalid",
      severity: "high" as const,
      title: this.title,
      evidence: error,
      url: page.finalUrl,
    }));
  },
});
