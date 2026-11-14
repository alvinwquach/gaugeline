import { defineCheck } from "../model.js";
import { linksWithoutName } from "../nav/names.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

/**
 * NAV-03. Reads the HTML already fetched: no request. The name is computed in the order of the
 * accessible name computation (aria-labelledby, aria-label, content, title); CSS is not applied.
 *
 * // [docs] uncited: the accessible name computation (W3C Accessible Name and Description Computation, and HTML-AAM for the a element) and WCAG 2.4.4 and 4.1.2. www.w3.org was not reachable from this session, so the order above is written from the maintainers' knowledge and the check states only what it saw: a link with no text, label or labelled image.
 */
export const navLinkNoName = defineCheck<PageSnapshot>({
  id: "nav-link-no-name",
  size: "S",
  done: "Every link in the header and footer has text, an aria-label or an image with alt text that says where it goes.",
  estimateChanges:
    "An icon link built from one shared component is one edit; links typed into a template are edited one by one.",
  area: "Visitors",
  severity: "medium",
  title: "Some menu links have no name",
  what: "A link in the header or footer holds only an icon, an image with no alt text or nothing at all, and has no aria-label.",
  why: 'A screen reader reads it as just "link", so a visitor who cannot see the icon cannot tell the basket from the phone number, and voice control has no name to say.',
  fix: 'Add an aria-label that says where the link goes (aria-label="Basket"), or give its image alt text, or add text that only screen readers see.',
  tech: "no request. a[href] inside the header (header, nav, [role=banner], or gaugeline.nav.json regions.header) or footer (footer, [role=contentinfo], or regions.footer) whose accessible name is empty after aria-labelledby, aria-label, the content (text, an image's alt, an svg title, a labelled descendant) and the title attribute; hidden and aria-hidden content adds nothing; whitespace, no-break space and zero-width characters are empty; CSS is not applied, so text hidden by a stylesheet counts as a name",
  run(page, ctx) {
    const missing = linksWithoutName(page, ctx.navRules);
    if (missing.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    const where = missing.map((l) => `${l.region} link to ${shortUrl(l.href, origin)}`);
    return [
      {
        checkId: "nav-link-no-name",
        severity: "medium",
        title: this.title,
        evidence: `${missing.length} ${missing.length === 1 ? "link has" : "links have"} no accessible name: ${firstFew(where)}`,
        url: page.finalUrl,
      },
    ];
  },
});
