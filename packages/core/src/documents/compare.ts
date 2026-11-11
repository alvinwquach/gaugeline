import { normaliseName } from "../products/match.js";
import type { DocItem } from "./lines.js";
import type { ReferenceItem } from "./types.js";

export interface PriceDiff {
  name: string;
  size?: string;
  symbol: string;
  doc: number;
  site: number;
  /** Where the site's price came from, in words. */
  source: string;
}

export interface Comparison {
  diffs: PriceDiff[];
  /** Items of the document found on the site (with or without a different price). */
  matched: number;
  /** On the site (a structured source) and not in the document. */
  siteOnly: string[];
  /** In the document and not on the site. Only when the two are shown to be the same menu. */
  docOnly: string[];
}

export interface PageText {
  /** "/menu": the page the text is from. */
  path: string;
  text: string;
}

/** "$16.00": two places, the symbol the document wrote. */
export function money(amount: number, symbol: string): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const sizeKey = (size: string | undefined): string =>
  size === undefined ? "" : normaliseName(size);

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for a name in running text: its words in order, with "&" and "and" the same word. */
function namePattern(name: string): RegExp | undefined {
  const words = name.match(/[\p{L}\p{N}]+|&/gu) ?? [];
  if (words.length === 0 || words.length > 8) return undefined;
  const body = words
    .map((w) => (w === "&" || w.toLowerCase() === "and" ? "(?:&|and)" : escape(w)))
    .join("[^\\p{L}\\p{N}]{1,3}");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

const SHOWN_PRICE = /[$€£]\s?(\d{1,4}(?:[.,]\d{1,2})?)|(?<![\d.,])(\d{1,4}[.,]\d{2})(?![\d])/g;

/** The first prices written within a short stretch after a name in a page's text. */
function pricesAfter(text: string, at: number): number[] {
  const out: number[] = [];
  for (const m of text.slice(at, at + 90).matchAll(SHOWN_PRICE)) {
    const n = (m[1] ?? m[2] ?? "").replace(",", ".");
    const [whole = "0", cents = ""] = n.split(".");
    out.push(Number(whole) * 100 + Number(cents.padEnd(2, "0")));
    if (out.length === 3) break;
  }
  return out;
}

/**
 * The document's prices against what the site says, in the order of trust: the structured
 * sources (the content system, the payment systems, declared facts: `reference`, already in
 * priority order, the first that names an item decides), then the words of the pages. Maps by
 * name key (G23d's normaliser) and size. A name that appears twice in the document with two prices
 * is ambiguous and not compared. "In the document, not on the site" is said only when the two are
 * shown to be the same menu (the pages carry at least half of the document's items, or a structured
 * source names one), so a page that lists only a few dishes does not make every dish "missing".
 */
export function compareDocument(
  items: readonly DocItem[],
  reference: readonly ReferenceItem[],
  pages: readonly PageText[],
): Comparison {
  const byKey = new Map<string, ReferenceItem[]>();
  for (const r of reference) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const counts = new Map<string, Set<number>>();
  for (const i of items) {
    const k = `${i.key}|${sizeKey(i.size)}`;
    counts.set(k, (counts.get(k) ?? new Set()).add(i.amount));
  }
  const diffs: PriceDiff[] = [];
  const used = new Set<ReferenceItem>();
  const unmatched: DocItem[] = [];
  let structured = 0;
  let pageHits = 0;
  let scanned = 0;
  for (const i of items) {
    if ((counts.get(`${i.key}|${sizeKey(i.size)}`)?.size ?? 0) > 1) continue;
    scanned++;
    const options = byKey.get(i.key) ?? [];
    const hit =
      options.find((r) => sizeKey(r.size) === sizeKey(i.size)) ??
      (i.size === undefined && options.length === 1 ? options[0] : undefined) ??
      (i.size !== undefined ? options.find((r) => r.size === undefined) : undefined);
    if (hit) {
      structured++;
      used.add(hit);
      if (hit.amount !== i.amount)
        diffs.push({
          name: i.name,
          ...(i.size === undefined ? {} : { size: i.size }),
          symbol: i.symbol ?? "$",
          doc: i.amount,
          site: hit.amount,
          source: hit.source,
        });
      continue;
    }
    const pattern = i.size === undefined ? namePattern(i.name) : undefined;
    let found = false;
    if (pattern)
      for (const p of pages) {
        const m = pattern.exec(p.text);
        if (!m) continue;
        found = true;
        const prices = pricesAfter(p.text, m.index + m[0].length);
        if (prices.length > 0 && !prices.includes(i.amount))
          diffs.push({
            name: i.name,
            symbol: i.symbol ?? "$",
            doc: i.amount,
            site: prices[0] ?? 0,
            source: `the page ${p.path}`,
          });
        break;
      }
    if (found) pageHits++;
    else unmatched.push(i);
  }
  const sameMenu = structured > 0 || (scanned >= 2 && pageHits * 2 >= scanned);
  const docOnly = sameMenu ? [...new Set(unmatched.map((i) => i.name))] : [];
  const siteOnly =
    structured > 0
      ? [
          ...new Set(
            reference
              .filter((r) => !used.has(r) && !items.some((i) => i.key === r.key))
              .map((r) => r.name),
          ),
        ]
      : [];
  return { diffs, matched: structured + pageHits, siteOnly, docOnly };
}
