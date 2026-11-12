import { businessFromJsonLd } from "../facts/business.js";
import { visibleText } from "../facts/extract.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

const digits = (s: string) => s.replace(/\D+/g, "");
const words = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The street of a JSON-LD address as it would be written on a page. */
function streetOf(page: PageSnapshot): string | undefined {
  for (const node of page.jsonLd) {
    const a = (node as { address?: { streetAddress?: unknown } } | null)?.address;
    if (a && typeof a === "object" && typeof a.streetAddress === "string") return a.streetAddress;
  }
  return undefined;
}

export const quotableFactsInDataOnly = defineCheck<PageSnapshot>({
  id: "quotable-facts-in-data-only",
  size: "S",
  done: "The phone number and street address in your structured data are also written as text on a page.",
  estimateChanges: "A fact that only lives in an image needs the text written out.",
  area: "Search & sharing",
  severity: "low",
  title: "Your phone number or address is in structured data but not written on the page",
  what: "The page's LocalBusiness structured data has a phone number or street address that appears in no visible text on the pages Gaugeline read (as sent, without JavaScript).",
  why: "An assistant answering 'what's their number?' quotes text it can read. A fact that is only in markup, in an image or built by scripts is often missed or second-guessed.",
  fix: "Write the phone number and street address as plain text on the home or contact page (the footer is fine), not only in an image or a script.",
  tech: "the JSON-LD telephone digits and streetAddress are not found in the visible text (scripts, styles and templates removed) of the checked page or the other pages sampled",
  async run(page, ctx) {
    const business = businessFromJsonLd(page);
    if (!business) return [];
    const pages = (await ctx.pages?.()) ?? [page];
    const texts = pages.map((p) => visibleText(p));
    const missing: string[] = [];
    if (business.phone && !texts.some((t) => digits(t).includes(digits(business.phone ?? "")))) {
      missing.push("phone");
    }
    const street = streetOf(page);
    if (street && !texts.some((t) => words(t).includes(words(street))))
      missing.push("street address");
    if (missing.length === 0) return [];
    return [
      {
        checkId: "quotable-facts-in-data-only",
        severity: "low",
        title: this.title,
        evidence: `${missing.join(" and ")} in structured data, not found as text on ${pages.length} page${pages.length === 1 ? "" : "s"} read`,
        url: page.finalUrl,
      },
    ];
  },
});
