import { toMinor } from "../products/money.js";
import { normaliseName } from "../products/match.js";

/** One price a line of a menu or price list states. */
export interface DocItem {
  /** As written, with the leader dots and the price taken off. */
  name: string;
  /** The shared name normaliser's key (G23d): case, punctuation and "&" versus "and" do not matter. */
  key: string;
  /** Minor units (cents): an integer, never a float. */
  amount: number;
  /** "6" for "(6) 9", the size a price is for. */
  size?: string;
  /** 1-based line in the text read. */
  line: number;
  /** The currency symbol written, when there was one. */
  symbol?: string;
}

const LEADER = /(?:[.\u00b7\u2026_]\s?){3,}|-{3,}/g;
const TIME = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const PHONE = /\d{3}[-.\s]\d{4}\b/;
const DAYS = /\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:days?|s)?\b/i;
const PRICE = String.raw`(\d{1,4}(?:[.,]\d{1,2})?)`;
const SIZED = new RegExp(
  String.raw`\(\s*([^)]{1,20}?)\s*\)\s*([$\u20ac\u00a3])?\s*${PRICE}(?![\d])`,
  "g",
);
const SIZED_LINE = new RegExp(
  String.raw`^(.+?)\s*((?:\(\s*[^)]{1,20}\)\s*[$\u20ac\u00a3]?\s*\d{1,4}(?:[.,]\d{1,2})?\s*(?:[/|,]\s*)?)+)$`,
);
const SINGLE = new RegExp(
  String.raw`^(.*?\p{L}.*?)\s+([$\u20ac\u00a3])?\s?${PRICE}(?:\s*(?:USD|EUR|GBP|CAD|AUD))?\s*$`,
  "u",
);

const letters = (text: string): number => (text.match(/\p{L}/gu) ?? []).length;
const tidy = (name: string): string =>
  name
    .replace(/[\s:\u2013\u2014*-]+$/g, "")
    .replace(/^[\s*\u2022-]+/, "")
    .trim();

function minor(price: string): number | undefined {
  try {
    return toMinor(price.replace(/^(\d+),(\d{1,2})$/, "$1.$2"));
  } catch {
    return undefined;
  }
}

/**
 * Item-and-price lines from the text of a document: "Smash Burger ........ 16", "Smash Burger
 * $16.00", "Lumpia (6) 9 / (12) 16". One pass, one line at a time, a regular expression with no
 * nested repetition over the text. Lines that look like hours, phone numbers or addresses, and
 * lines with no price, give nothing: a line that does not parse is left out, never guessed.
 */
export function parseItemLines(text: string): DocItem[] {
  const out: DocItem[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (raw.length > 400) return;
    const line = raw.replace(LEADER, "  ").replace(/\s+$/, "");
    if (TIME.test(line) || PHONE.test(line) || (DAYS.test(line) && /\d/.test(line))) return;
    const sized = SIZED_LINE.exec(line);
    if (sized && letters(sized[1] ?? "") >= 2) {
      const name = tidy(sized[1] ?? "");
      for (const m of (sized[2] ?? "").matchAll(SIZED)) {
        const amount = minor(m[3] ?? "");
        if (amount === undefined) continue;
        out.push({
          name,
          key: normaliseName(name),
          amount,
          size: m[1] ?? "",
          line: i + 1,
          ...(m[2] ? { symbol: m[2] } : {}),
        });
      }
      return;
    }
    const m = SINGLE.exec(line);
    if (!m) return;
    const name = tidy(m[1] ?? "");
    const amount = minor(m[3] ?? "");
    if (amount === undefined || letters(name) < 2 || name.length > 80) return;
    out.push({
      name,
      key: normaliseName(name),
      amount,
      line: i + 1,
      ...(m[2] ? { symbol: m[2] } : {}),
    });
  });
  return out;
}
