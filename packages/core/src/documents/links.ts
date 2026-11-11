import type { PageSnapshot } from "../snapshot.js";
import type { DocumentsConfig } from "./config.js";

export interface DocumentLink {
  url: string;
  /** Why it is a candidate: the config named it, it is a .pdf link, or its words say menu, price list, brochure, rates. */
  via: "config" | "pdf" | "words";
}

const WORDS = /\b(?:menu|menus|price\s*list|prices|pricing|brochure|rates?)\b/i;
const FILE_WORDS = /\b(?:pdf|download|printable|print)\b/i;
const PAGE_END = /\.(?:html?|php|aspx?)$/i;

/**
 * The documents linked from the pages read: PDF links first, then links whose text or rel says menu,
 * price list, brochure or rates (a page that is plainly a page is not one, and the link that turns
 * out to lead to HTML is dropped when it is asked). The config adds some and leaves some out. One
 * pass over the links; a Set of addresses keeps each once.
 */
export function findDocumentLinks(
  pages: readonly PageSnapshot[],
  config: DocumentsConfig["documents"] | undefined,
): DocumentLink[] {
  const seen = new Set<string>();
  const read = new Set(pages.map((p) => p.finalUrl.split("#")[0]));
  const out: DocumentLink[] = [];
  const excluded = (url: string): boolean => (config?.exclude ?? []).some((e) => url.includes(e));
  const add = (raw: string, base: string, via: DocumentLink["via"]): void => {
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.hash = "";
    const href = url.href;
    if (seen.has(href) || read.has(href) || excluded(href)) return;
    seen.add(href);
    out.push({ url: href, via });
  };
  const base = pages[0]?.finalUrl ?? "https://invalid.example/";
  for (const entry of config?.include ?? []) add(entry, base, "config");
  for (const p of pages)
    for (const l of p.links)
      try {
        if (new URL(l.href, p.finalUrl).pathname.toLowerCase().endsWith(".pdf"))
          add(l.href, p.finalUrl, "pdf");
      } catch {
        // not an address
      }
  for (const p of pages)
    for (const l of p.links) {
      let url: URL;
      try {
        url = new URL(l.href, p.finalUrl);
      } catch {
        continue;
      }
      const path = url.pathname;
      if (PAGE_END.test(path) || path.toLowerCase().endsWith(".pdf")) continue;
      if (!WORDS.test(l.text) && !WORDS.test(l.rel ?? "")) continue;
      // A same-site address with no file extension that does not say it is a download is a page
      // ("/menu"), and the page checks read pages; a file host, an extension or "download" is a file.
      const file =
        url.host !== new URL(p.finalUrl).host ||
        /\.[a-z0-9]{2,5}$/i.test(path) ||
        FILE_WORDS.test(`${l.text} ${path}`);
      if (file) add(l.href, p.finalUrl, "words");
    }
  return out;
}
