import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { capFindings } from "./hidden-text/cap.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { scanText } from "./hidden-text/scan.js";
import { isHtmlPage } from "./page.js";

export const zeroWidthInText = defineCheck<PageSnapshot>({
  id: "zero-width-in-text",
  area: "Security & email",
  severity: "low",
  title: "Invisible characters sit inside words on the page",
  what: "Zero-width characters are inside words in the page's visible text.",
  why: "A word with a hidden character in it no longer matches itself: search can't find it, and copy-pasted or tampered text can carry marks nobody meant to publish.",
  fix: "Remove them from the source text: retype the word, or paste it as plain text.",
  tech: "U+200B to U+200D, U+2060 to U+2064, U+180E or U+FEFF between two Latin, Cyrillic, Greek or digit characters in visible text; emoji joiners, Persian non-joiners and zero-width marks at the end of a text (content source maps) are not counted",
  run(page) {
    if (!isHtmlPage(page)) return [];
    return capFindings(
      scanText(page).zeroWidth.map((z) => ({
        checkId: "zero-width-in-text",
        severity: "low" as const,
        title: this.title,
        evidence: `${escapeInvisible(z.where, 80)}: ${z.count} zero-width character${z.count === 1 ? "" : "s"} inside words, for example "${escapeInvisible(z.sample, 60)}"`,
        url: page.finalUrl,
      })),
    );
  },
});
