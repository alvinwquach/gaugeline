/**
 * Money as integers in minor units, with the currency's own exponent (JPY 0, USD 2, BHD 3). Never
 * a float: an amount is read digit by digit from its text. ISO 4217 exponents for the currencies
 * Shopify sells in that are not 2 (an unlisted currency is read with 2).
 */
const ZERO: ReadonlySet<string> = new Set([
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
  "UGX",
  "XAF",
  "XOF",
  "XPF",
  "PYG",
  "RWF",
]);
const THREE: ReadonlySet<string> = new Set(["BHD", "KWD", "OMR", "JOD", "TND", "IQD", "LYD"]);

export function exponentOf(currency: string): number {
  const c = currency.toUpperCase();
  return ZERO.has(c) ? 0 : THREE.has(c) ? 3 : 2;
}

/** "48", "48.0", "1200.50" (a machine amount: dot decimal, no grouping) to minor units; undefined otherwise. */
export function machineMinor(amount: string, currency: string): number | undefined {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) return undefined;
  const e = exponentOf(currency);
  const frac = m[2] ?? "";
  // More decimals than the currency has is only accepted when the extra digits are zeros.
  if (/[1-9]/.test(frac.slice(e))) return undefined;
  return Number(m[1]) * 10 ** e + (e === 0 ? 0 : Number(frac.slice(0, e).padEnd(e, "0")));
}

const CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CHF", "SEK", "MXN", "BHD"];
const SYMBOL: Readonly<Record<string, string>> = Object.freeze({
  "\u20AC": "EUR",
  "\u00A3": "GBP",
});

/**
 * What a shopper reads ("$48.00", "48,00 EUR", "JPY 4,800"): the amount in minor units for the
 * given currency, and the currency only when the text names it unambiguously (a code, or \u20AC or \u00A3; a
 * bare $ or \u00A5 names several). Undefined when the text does not hold exactly one amount.
 */
export function shownMinor(
  text: string,
  currency: string,
): { minor: number; currency?: string } | undefined {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 80);
  const found = [...t.matchAll(/\d[\d.,\u00A0 ]*\d|\d/g)].map((x) =>
    x[0].replace(/[\u00A0 ]/g, ""),
  );
  if (found.length !== 1) return undefined;
  const raw = found[0] as string;
  const e = exponentOf(currency);
  // The last separator is the decimal one only when exactly `e` digits follow it (and e > 0).
  const lastSep = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
  let whole = raw;
  let frac = "";
  if (lastSep >= 0 && raw.length - lastSep - 1 === e && e > 0) {
    whole = raw.slice(0, lastSep);
    frac = raw.slice(lastSep + 1);
  } else if (lastSep >= 0 && raw.length - lastSep - 1 !== 3) {
    return undefined; // neither a decimal of this currency nor a thousands group
  }
  const digits = whole.replace(/[.,]/g, "");
  if (!/^\d{1,12}$/.test(digits)) return undefined;
  const minor = Number(digits) * 10 ** e + (e === 0 ? 0 : Number(frac.padEnd(e, "0")));
  const named = CODES.find((c) => new RegExp(`\\b${c}\\b`).test(t));
  const sym = Object.entries(SYMBOL).find(([s]) => t.includes(s))?.[1];
  const cur = named ?? sym;
  return cur === undefined ? { minor } : { minor, currency: cur };
}
