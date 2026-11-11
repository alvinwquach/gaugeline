import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";
import { publicFiles, showsPrice } from "./paid-files.js";

/** How many files a line of evidence lists before it says "and N more". */
const SHOWN = 5;

export const assetFilePublic = defineCheck<PageSnapshot>({
  id: "asset-file-public",
  size: "M",
  done: "The file is served from a route that checks the purchase and hands back a short-lived link, or is left public on purpose.",
  estimateChanges:
    "A free file needs nothing. A file that will be sold means building the route and moving the file.",
  area: "Sales & prices",
  severity: "low",
  title: "A downloadable file is on a public asset address",
  what: "A page links to a file (pdf, zip, epub, mp3, mp4, docx or xlsx) on a public asset store and shows no price, or the link is a terms, privacy or policy page.",
  why: "That is fine for a brochure or a menu. It becomes a problem the day the file is something a customer bought, because anyone with the address can open it.",
  fix: "If the file is free, nothing to do. If it will ever be sold, serve it from a download route that checks the purchase and hands back a short-lived signed link.",
  tech: "a[href] to a file with a sold file type on a public asset store host, on a page with no price, or whose link text is terms, privacy or policy; one finding per page; the file is never requested; the query string is not printed; a signed address with an expiry is a pass",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const priced = showsPrice(page);
    const files = publicFiles(page).filter((f) => !priced || f.legalOnly);
    if (files.length === 0) return [];
    const items = files.slice(0, SHOWN).map((f) => {
      const text = f.texts.find((t) => t.trim() !== "");
      return text === undefined ? f.address : `"${escapeInvisible(text, 60)}" (${f.address})`;
    });
    const more = files.length > SHOWN ? ` and ${files.length - SHOWN} more` : "";
    const lead =
      files.length === 1
        ? "Links to a downloadable file on a public asset address:"
        : "Links to downloadable files on public asset addresses:";
    return [
      {
        checkId: "asset-file-public",
        severity: "low",
        title: this.title,
        evidence: `${lead} ${items.join(", ")}${more}.`,
        url: page.finalUrl,
      },
    ];
  },
});
