import { analyseDocuments, type AnalysedDocument } from "../documents/analysis.js";
import { money } from "../documents/compare.js";
import { INSTALL_HINT } from "../documents/types.js";
import { defineCheck, type CheckContext, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/** The most items or days a finding lists before it counts the rest. */
const LIST_MAX = 5;

const safe = (text: string): string => escapeInvisible(text, 60);

function listed(items: readonly string[]): string {
  const shown = items.slice(0, LIST_MAX).join("; ");
  return items.length > LIST_MAX ? `${shown}; and ${items.length - LIST_MAX} more` : shown;
}

/** "the document is https://... (last modified ...)": the address read, after any redirect, and its date. */
const where = (d: AnalysedDocument): string =>
  `${d.url}${d.lastModified ? ` (last modified ${safe(d.lastModified)})` : ""}`;

/**
 * What every document check starts from: the analysis of the run (one read for all four), with the
 * documents that could not be fetched or read reported once for this check as could-not-check
 * (never as a pass). Returns the documents that were read.
 */
async function start(page: PageSnapshot, ctx: CheckContext): Promise<AnalysedDocument[]> {
  const run = await analyseDocuments(page, ctx);
  for (const n of run.notes) ctx.couldNotCheck?.(n.url, n.reason);
  for (const d of run.documents)
    if (d.notRead)
      ctx.couldNotCheck?.(
        d.url,
        d.notRead === INSTALL_HINT
          ? INSTALL_HINT
          : `${d.notRead}, so it was not compared with the site`,
      );
  return run.documents.filter((d) => d.notRead === undefined && d.unreadable === undefined);
}

export const documentPriceMismatch = defineCheck<PageSnapshot>({
  id: "document-price-mismatch",
  size: "S",
  done: "The prices in the PDF menu or price list are the prices on the site.",
  estimateChanges:
    "Re-export the PDF from the updated menu (or price list), or take it down. Decide which price is right first.",
  area: "Sales & prices",
  severity: "high",
  title: "A PDF menu or price list shows a different price than the site",
  what: "A PDF linked from your site (a menu, price list or brochure) gives an item a different price than the site does.",
  why: "People screenshot the PDF. A burger that is $16 on the page and $14 in the printable menu is a price you either honour at a loss or argue about at the counter.",
  fix: "Decide which price is right, then change the other. If the PDF is last season's, re-export it from the current menu, or remove the link until you can.",
  tech: "GET of each linked PDF (HEAD first for size, type and Last-Modified; redirects followed, the final address reported; files over 10 MB skipped with the reason), text read by the optional @gaugeline/documents package, item-and-price lines parsed (name, price in cents, optional size) and compared by normalised name and size with the first source that names the item: the content system and Stripe, then the facts in gaugeline.facts.json, then the words of the pages; both values are quoted; an item that appears twice in the PDF with two prices is not compared; without the package the check says it could not check",
  async run(page, ctx) {
    const found: Finding[] = [];
    for (const d of await start(page, ctx)) {
      const diffs = d.comparison?.diffs ?? [];
      if (diffs.length === 0) continue;
      const lines = diffs.map(
        (x) =>
          `${safe(x.name)}${x.size ? ` (${safe(x.size)})` : ""}: the document says ${money(x.doc, x.symbol)}, ${x.source} says ${money(x.site, x.symbol)}`,
      );
      found.push({
        checkId: "document-price-mismatch",
        severity: "high",
        title: this.title,
        evidence: `In ${where(d)}, ${diffs.length} ${diffs.length === 1 ? "price differs" : "prices differ"} from the site: ${listed(lines)}`,
        url: d.url,
      });
    }
    return found;
  },
});

export const documentItemMissing = defineCheck<PageSnapshot>({
  id: "document-item-missing",
  size: "S",
  done: "The PDF and the site list the same items.",
  estimateChanges: "Add or remove the items in the PDF or on the site so the two lists match.",
  area: "Sales & prices",
  severity: "medium",
  title: "A PDF menu or price list and the site list different items",
  what: "An item is on the site but not in the linked PDF, or the PDF still lists an item the site no longer has.",
  why: "A dish removed from the site that is still on the printed menu is one you get asked for. A new one missing from the PDF is one nobody orders from it.",
  fix: "Update the PDF or the site so both list the same items, or remove the PDF link until the PDF is current.",
  tech: "same reading and matching as document-price-mismatch (normalised names, '&' and 'and' alike); items the site's structured sources name that the PDF does not, and PDF items found nowhere on the site; the second list is reported only when the two are shown to be the same menu (a structured source names one of the PDF's items, or the pages carry at least half of them), so a page listing a few dishes does not make every dish missing; both lists name at most five items and count the rest",
  async run(page, ctx) {
    const found: Finding[] = [];
    for (const d of await start(page, ctx)) {
      const c = d.comparison;
      if (!c || (c.siteOnly.length === 0 && c.docOnly.length === 0)) continue;
      const parts = [
        ...(c.siteOnly.length > 0
          ? [`On the site but not in the document: ${listed(c.siteOnly.map(safe))}`]
          : []),
        ...(c.docOnly.length > 0
          ? [`In the document but not on the site: ${listed(c.docOnly.map(safe))}`]
          : []),
      ];
      found.push({
        checkId: "document-item-missing",
        severity: "medium",
        title: this.title,
        evidence: `${parts.join(". ")} (document ${where(d)})`,
        url: d.url,
      });
    }
    return found;
  },
});

export const documentHoursMismatch = defineCheck<PageSnapshot>({
  id: "document-hours-mismatch",
  size: "S",
  done: "The opening hours in the PDF are the hours on the site and its listings.",
  estimateChanges:
    "Update the hours in the PDF, or on the site and listings, after deciding which are right.",
  area: "Search & sharing",
  severity: "high",
  title: "A PDF shows different opening hours than the site or a listing",
  what: "A PDF linked from your site states opening hours that differ from the hours on your site or on a business listing.",
  why: "People plan the evening from the printed menu. Hours that are an hour off in the PDF send them to a closed door, or turn them away from a kitchen that is still open.",
  fix: "Decide which hours are right, then fix the others: re-export the PDF, or update the site and the listings.",
  tech: "the PDF's opening hours are read by the same parser the listing checks use (per-day intervals in the venue's local time; a close after midnight belongs to the day it opens; a day given two answers is not compared); only days the PDF states are compared, against the hours fact in gaugeline.facts.json or LocalBusiness structured data, and against each configured listing that has hours; a PDF that states hours when the site states none is could-not-check, never a pass",
  async run(page, ctx) {
    const found: Finding[] = [];
    for (const d of await start(page, ctx)) {
      if (d.hoursNotCompared)
        ctx.couldNotCheck?.(d.url, `${d.hoursNotCompared}, so its hours were not compared`);
      if (d.hourDifferences.length === 0) continue;
      found.push({
        checkId: "document-hours-mismatch",
        severity: "high",
        title: this.title,
        evidence: `${listed(d.hourDifferences)}${d.siteHoursFrom ? ` (site hours from ${d.siteHoursFrom})` : ""} (document ${where(d)})`,
        url: d.url,
      });
    }
    return found;
  },
});

export const documentUnreadable = defineCheck<PageSnapshot>({
  id: "document-unreadable",
  size: "S",
  done: "Every PDF menu or price list linked from the site has a text layer Gaugeline can read.",
  estimateChanges:
    "Re-export the PDF as text (not a scan) if you want it checked, or ignore this note.",
  area: "Sales & prices",
  severity: "low",
  title: "A PDF could not be read, so it was not compared with the site",
  what: "A PDF linked from your site has no text Gaugeline can read (a scan or a picture of a page, an encrypted file, or fonts that do not say which letters they are).",
  why: "Nothing in it was compared with your site, so a wrong price in it would go unseen. Search engines and screen readers cannot read a scan either.",
  fix: "Export the PDF from the original menu or price list as text, not from a scan, and leave it unencrypted. Gaugeline never reads images (no OCR): a guessed price would be a false finding.",
  tech: "the linked PDF is read by the optional @gaugeline/documents package, text layer only, no OCR; a file with no text operators, an encrypted file, fonts without a ToUnicode map and streams of an unsupported kind are reported here (low severity) with the reason; a file that is too big, cut short, refused or not a PDF is could-not-check instead; limits: 10 MB per file (config documents.maxMegabytes up to 25), 200 pages, 4 MiB inflated per stream, 48 MiB in all",
  async run(page, ctx) {
    const run = await analyseDocuments(page, ctx);
    for (const n of run.notes) ctx.couldNotCheck?.(n.url, n.reason);
    const found: Finding[] = [];
    for (const d of run.documents) {
      if (d.notRead)
        ctx.couldNotCheck?.(
          d.url,
          d.notRead === INSTALL_HINT ? INSTALL_HINT : `${d.notRead}, so it was not read`,
        );
      if (d.unreadable)
        found.push({
          checkId: "document-unreadable",
          severity: "low",
          title: this.title,
          evidence: `${d.url} could not be read: ${d.unreadable}${d.lastModified ? ` (last modified ${safe(d.lastModified)})` : ""}. Nothing in it was compared with the site.`,
          url: d.url,
        });
    }
    return found;
  },
});

export const DOCUMENT_CHECKS = [
  documentHoursMismatch,
  documentItemMissing,
  documentPriceMismatch,
  documentUnreadable,
] as const;

export { INSTALL_HINT };
