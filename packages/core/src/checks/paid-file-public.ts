import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { isHtmlPage } from "./page.js";
import { publicFiles, showsPrice } from "./paid-files.js";

export const paidFilePublic = defineCheck<PageSnapshot>({
  id: "paid-file-public",
  area: "Sales & prices",
  severity: "high",
  title: "A file people pay for is on a public address",
  what: "A page that shows a price links straight to a file (pdf, zip, epub, mp3, mp4, docx or xlsx) on a public asset store.",
  why: "Asset stores are world-readable by design. Anyone who has the address, or finds it in the page's source or a search engine, can download the file without paying.",
  fix: "Check the purchase in your own download route, then hand back a short-lived signed link. Never put the asset address in the page or in an email.",
  tech: "a[href] to a file with a sold file type (pdf, zip, epub, mp3, mp4, docx, xlsx) on a public asset store host (Sanity file CDN, S3, Google Cloud Storage, Azure blob, R2, Supabase public, Cloudinary and similar) on a page with a price (a currency next to a number in the visible text, or an Offer price in the structured data); the file is never requested; the query string is not printed; a signed address with an expiry is a pass; a link whose text is terms, privacy or policy is asset-file-public instead",
  run(page) {
    if (!isHtmlPage(page) || !showsPrice(page)) return [];
    const found = [];
    for (const file of publicFiles(page)) {
      if (file.legalOnly) continue;
      const text = file.texts.find((t) => t.trim() !== "") ?? "";
      const subject = text === "" ? "A link with no text" : `"${escapeInvisible(text, 60)}" links`;
      found.push({
        checkId: "paid-file-public",
        severity: "high" as const,
        title: this.title,
        evidence: `${text === "" ? `${subject} points` : subject} to ${file.address}, a public asset address, and the page shows a price.`,
        url: page.finalUrl,
      });
    }
    return found;
  },
});
