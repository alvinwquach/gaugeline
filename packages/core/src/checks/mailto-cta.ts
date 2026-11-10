import { findMailtoCtas } from "../forms/mailto.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";

/** How many buttons a line of evidence lists before it says "and N more". */
const SHOWN = 5;

export const mailtoCta = defineCheck<PageSnapshot>({
  id: "mailto-cta",
  area: "Leads",
  severity: "medium",
  title: "Some buttons open an email instead of a form",
  what: 'A contact button ("Talk to an expert", "Get a quote") opens one person\'s email program instead of a form.',
  why: "The enquiry skips your CRM: it lands in one inbox with no campaign details, nobody else sees it, and visitors without an email program set up can't send it at all.",
  fix: "Point the button at a form or a booking page that sends the enquiry to your CRM, and keep the email address as a plain fallback.",
  tech: "a[href] starting mailto: with an address, whose text is a contact call to action (contact, talk, speak, get in touch, email us, book, quote, demo and similar) and not an address itself; one finding per page; the link's styling is not visible to Gaugeline",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const found = findMailtoCtas(page);
    if (found.length === 0) return [];
    const shown = found
      .slice(0, SHOWN)
      .map((c) => `"${escapeInvisible(c.text, 60)}" (mailto:${escapeInvisible(c.address, 80)})`);
    const more = found.length > SHOWN ? ` and ${found.length - SHOWN} more` : "";
    return [
      {
        checkId: "mailto-cta",
        severity: "medium",
        title: this.title,
        evidence: `Opens an email instead of a form: ${shown.join(", ")}${more}.`,
        url: page.finalUrl,
      },
    ];
  },
});
