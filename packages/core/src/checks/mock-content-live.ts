import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { contentIndex } from "./content/parse.js";
import { MOCK_PHRASES } from "./content/lists.js";
import { isHtmlPage } from "./page.js";
import { firstFew } from "./site-helpers.js";

const EXAMPLE_EMAIL = /\b[\w.+-]+@example\.(?:com|org|net)\b/gi;
/** North American 555 numbers: (415) 555-0100, 415.555.0100, 555-1234. */
const PHONE_555 = /(?:\(?\b\d{3}\)?[\s.-]?)?\b555[\s.-]\d{4}\b/g;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const mockContentLive = defineCheck<PageSnapshot>({
  id: "mock-content-live",
  area: "Visitors",
  severity: "high",
  title: "Test content is on the live site",
  what: "The page's main content shows test or sample content: a test product, a sample post, John Doe, an example.com email address or a 555 phone number.",
  why: "Unlike placeholder copy, a visitor can act on it: buy the test product, email the example address or call the fake number.",
  fix: "Delete or unpublish the test entries in the CMS or shop, and replace sample contact details with real ones.",
  tech: `main content (code and pre ignored) contains ${MOCK_PHRASES.map((p) => `"${p}"`).join(", ")}, an @example.com/.org/.net address, or a 555 phone number (English lists)`,
  run(page) {
    if (!isHtmlPage(page)) return [];
    const text = contentIndex(page).mainText;
    const found: string[] = [];
    for (const phrase of MOCK_PHRASES) {
      const re = new RegExp(`(?<![\\w])${escape(phrase)}(?![\\w])`, "gi");
      for (const m of text.matchAll(re)) found.push(`"${m[0]}"`);
    }
    for (const re of [EXAMPLE_EMAIL, PHONE_555])
      for (const m of text.matchAll(re)) found.push(`"${m[0].trim()}"`);
    if (found.length === 0) return [];
    return [
      {
        checkId: "mock-content-live",
        severity: "high",
        title: this.title,
        evidence: `${found.length} test ${found.length === 1 ? "item" : "items"} in the main content: ${firstFew(found)}`,
        url: page.finalUrl,
      },
    ];
  },
});
