import { fold } from "../switches/text.js";

/**
 * What a plan on a page says about its price, in words: how often it bills, the trial it promises,
 * whether tax is in the number, and the amounts. English and Spanish. Page text is data: nothing
 * here follows an instruction in it, and these are plain patterns over folded text (no accents,
 * lower case), so the same text always gives the same answer.
 */

export type Unit = "day" | "week" | "month" | "year";

/** "Every `count` `unit`s". A page that says "per month" is { unit: "month", count: 1 }. */
export interface Cadence {
  unit: Unit;
  count: number;
}

const UNIT_WORDS: Readonly<Record<string, Unit>> = {
  day: "day",
  days: "day",
  dia: "day",
  dias: "day",
  week: "week",
  weeks: "week",
  wk: "week",
  wks: "week",
  semana: "week",
  semanas: "week",
  sem: "week",
  month: "month",
  months: "month",
  mo: "month",
  mos: "month",
  mes: "month",
  meses: "month",
  year: "year",
  years: "year",
  yr: "year",
  yrs: "year",
  ano: "year",
  anos: "year",
};
const UNITS = Object.keys(UNIT_WORDS).join("|");
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  six: 6,
  twelve: 12,
  dos: 2,
  tres: 3,
  cuatro: 4,
  seis: 6,
  doce: 12,
};
const NUMBER = `\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")}`;

function count(word: string): number {
  return NUMBER_WORDS[word] ?? Number(word);
}

// ---- trials -------------------------------------------------------------------------------------

/** A trial in days: exact for days and weeks, a range for months (28 to 31 days each). */
export interface TrialDays {
  min: number;
  max: number;
}

const TRIALS: readonly RegExp[] = [
  // "7-day free trial", "14 day trial"
  new RegExp(`\\b(${NUMBER})\\s*-?\\s*(${UNITS})\\s*(?:free\\s+)?(?:trial|test)\\b`, "g"),
  // "7 dias de prueba (gratis)"
  new RegExp(`\\b(${NUMBER})\\s*-?\\s*(${UNITS})\\s+de\\s+prueba\\b`, "g"),
  // "free trial of 7 days", "prueba gratis de 7 dias"
  new RegExp(
    `\\b(?:free\\s+trial|trial|prueba(?:\\s+(?:gratis|gratuita))?)\\s+(?:of|for|de|por)\\s+(${NUMBER})\\s*(${UNITS})\\b`,
    "g",
  ),
  // "7 days free", "14 dias gratis": days and weeks only ("2 months free" is a discount, not a trial)
  new RegExp(
    `\\b(${NUMBER})\\s*-?\\s*(days?|dias?|weeks?|wks?|semanas?)\\s+(?:free|gratis|gratuit[oa]s?)\\b`,
    "g",
  ),
  // "first month free", "primer mes gratis"
  new RegExp(`\\b(?:first|primer[oa]?)\\s+()(${UNITS})\\s+(?:is\\s+)?(?:free|gratis)\\b`, "g"),
];

interface Span {
  index: number;
  end: number;
}

function trialSpans(f: string): (Span & { days: TrialDays })[] {
  const out: (Span & { days: TrialDays })[] = [];
  for (const re of TRIALS)
    for (const m of f.matchAll(re)) {
      const unit = UNIT_WORDS[m[2] ?? ""];
      if (unit === undefined) continue;
      const n = m[1] === "" || m[1] === undefined ? 1 : count(m[1]);
      if (!Number.isInteger(n) || n < 1) continue;
      const days: TrialDays | null =
        unit === "day"
          ? { min: n, max: n }
          : unit === "week"
            ? { min: 7 * n, max: 7 * n }
            : unit === "month"
              ? { min: 28 * n, max: 31 * n }
              : null; // A year-long trial is not a trial anyone offers; leave it unread.
      if (days !== null) out.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, days });
    }
  return out.sort((a, b) => a.index - b.index);
}

/** The free trial the text promises, or null. The earliest one if it names several. */
export function parseTrial(text: string): TrialDays | null {
  return trialSpans(fold(text))[0]?.days ?? null;
}

/** Whether a Stripe trial of `days` is the trial the page promises. */
export function trialAgrees(page: TrialDays, days: number): boolean {
  return days >= page.min && days <= page.max;
}

// ---- how often ----------------------------------------------------------------------------------

const COUNTED = new RegExp(`\\b(?:every|each|cada|per|por)\\s+(${NUMBER})\\s*(${UNITS})\\b`, "g");
const OTHER = new RegExp(`\\bevery\\s+other\\s+(${UNITS})\\b`, "g");
const SINGULAR = new RegExp(
  `(?:\\b(?:per|a|an|each|every|cada|por|al|a\\s+la)\\s+|/\\s*)(${UNITS})\\b`,
  "g",
);
const ADJECTIVES: readonly [RegExp, Cadence][] = [
  [/\b(?:monthly|mensual(?:es|mente)?)\b/g, { unit: "month", count: 1 }],
  [/\b(?:yearly|annual(?:ly)?|anual(?:es|mente)?|per\s+annum)\b/g, { unit: "year", count: 1 }],
  [/\b(?:weekly|semanal(?:es|mente)?)\b/g, { unit: "week", count: 1 }],
  [/\b(?:daily|diari[oa]s?)\b/g, { unit: "day", count: 1 }],
  [/\b(?:quarterly|trimestral(?:es|mente)?)\b/g, { unit: "month", count: 3 }],
];

/** The text with the spans blanked, so a trial's "7 days" is not read as a billing interval. */
function without(f: string, spans: readonly Span[]): string {
  let out = f;
  for (const s of spans)
    out = out.slice(0, s.index) + " ".repeat(s.end - s.index) + out.slice(s.end);
  return out;
}

/**
 * Every billing interval the text names, in order. Trial phrases are set aside first. "Per month",
 * "/mo", "monthly", "al mes", "mensual", "every 3 months", "cada 3 meses", "quarterly".
 */
export function cadences(text: string): Cadence[] {
  const f = without(fold(text), trialSpans(fold(text)));
  const found: { index: number; cadence: Cadence }[] = [];
  const add = (index: number | undefined, cadence: Cadence | undefined) => {
    if (index !== undefined && cadence !== undefined) found.push({ index, cadence });
  };
  for (const m of f.matchAll(COUNTED)) {
    const unit = UNIT_WORDS[m[2] ?? ""];
    add(m.index, unit === undefined ? undefined : { unit, count: count(m[1] ?? "") });
  }
  for (const m of f.matchAll(OTHER)) {
    const unit = UNIT_WORDS[m[1] ?? ""];
    add(m.index, unit === undefined ? undefined : { unit, count: 2 });
  }
  for (const m of f.matchAll(SINGULAR)) {
    const unit = UNIT_WORDS[m[1] ?? ""];
    add(m.index, unit === undefined ? undefined : { unit, count: 1 });
  }
  for (const [re, cadence] of ADJECTIVES) for (const m of f.matchAll(re)) add(m.index, cadence);
  return found.sort((a, b) => a.index - b.index).map((c) => c.cadence);
}

/** Months in a cadence (a year is 12), or days (a week is 7): the form two cadences are compared in. */
function canonical(c: Cadence): string {
  if (c.unit === "year") return `month:${12 * c.count}`;
  if (c.unit === "week") return `day:${7 * c.count}`;
  return `${c.unit}:${c.count}`;
}

/** "Every 12 months" is "per year", and "every 7 days" is "per week". */
export function sameCadence(a: Cadence, b: Cadence): boolean {
  return canonical(a) === canonical(b);
}

/**
 * How often the text says it bills, or null when it says nothing or says two different things
 * ("$19/mo billed annually", "$20/mo or $200/yr"). Two different answers are never guessed between.
 */
export function parseCadence(text: string): Cadence | null {
  const all = cadences(text);
  const first = all[0];
  if (first === undefined) return null;
  return all.every((c) => sameCadence(c, first)) ? first : null;
}

/** Whether the text names more than one billing interval. */
export function cadenceUnclear(text: string): boolean {
  const all = cadences(text);
  const first = all[0];
  return first !== undefined && !all.every((c) => sameCadence(c, first));
}

/** "every month", "every 3 months", "every year": how Stripe's interval reads in a sentence. */
export function describeCadence(c: Cadence): string {
  return c.count === 1 ? `every ${c.unit}` : `every ${c.count} ${c.unit}s`;
}

// ---- tax ----------------------------------------------------------------------------------------

export type TaxDisplay = "inclusive" | "exclusive";

const TAX = "(?:tax|vat|iva|gst|impuestos?)";
const INCLUSIVE = new RegExp(
  `\\b${TAX}\\s+(?:included|incl\\w*|incluid[oa]s?)\\b|\\bincl\\w*\\.?\\s+${TAX}\\b|\\b${TAX}[- ]inclusive\\b|\\b(?:iva|impuestos)\\s+incluid[oa]s?\\b`,
);
const EXCLUSIVE = new RegExp(
  `\\+\\s*${TAX}\\b|\\bplus\\s+${TAX}\\b|\\b${TAX}\\s+(?:not\\s+included|extra|excluded|excl\\w*)\\b|\\bexcl\\w*\\.?\\s+${TAX}\\b|\\b${TAX}[- ]exclusive\\b|\\bmas\\s+${TAX}\\b|\\bantes\\s+de\\s+${TAX}\\b|\\bsin\\s+${TAX}\\b|\\bbefore\\s+${TAX}\\b`,
);

/** Whether the text says tax is in the number or on top of it; null when it says neither (or both). */
export function parseTaxDisplay(text: string): TaxDisplay | null {
  const f = fold(text);
  const inc = INCLUSIVE.test(f);
  const exc = EXCLUSIVE.test(f);
  if (inc === exc) return null;
  return inc ? "inclusive" : "exclusive";
}

// ---- amounts ------------------------------------------------------------------------------------

/**
 * A price as the page wrote it. `text` is a plain decimal ("49.00"), `shown` the words as written
 * ("$49"), `currencies` the ISO codes the symbol or code can mean (a dollar sign can be several).
 */
export interface ShownAmount {
  text: string;
  shown: string;
  currencies: string[];
}

const SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  $: ["usd", "cad", "aud", "nzd", "mxn", "sgd", "hkd"],
  US$: ["usd"],
  CA$: ["cad"],
  MX$: ["mxn"],
  AU$: ["aud"],
  A$: ["aud"],
  NZ$: ["nzd"],
  "\u20AC": ["eur"],
  "\u00A3": ["gbp"],
  "\u00A5": ["jpy", "cny"],
  "\u20A9": ["krw"],
};
const CODES =
  "USD|EUR|GBP|CAD|AUD|NZD|MXN|JPY|CHF|SEK|NOK|DKK|BRL|INR|KRW|SGD|HKD|COP|ARS|CLP|PEN|PLN|CZK|ZAR";
const SYM = "US\\$|CA\\$|MX\\$|AU\\$|A\\$|NZ\\$|[$\u20AC\u00A3\u00A5\u20A9]";
const NUM = "\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,3})?|\\d+(?:[.,]\\d{1,3})?";
const PREFIXED = new RegExp(`(${SYM}|\\b(?:${CODES})\\b)\\s?(${NUM})(?![\\d])`, "gu");
const SUFFIXED = new RegExp(
  `(?<![\\d.,])(${NUM})\\s?(\\b(?:${CODES})\\b|${SYM})(?![\\p{L}\\d])`,
  "gu",
);

/** "1,299.00", "1.299,00", "49,5", "1,299", "49.000" as a plain decimal text. */
function plainNumber(raw: string): string {
  const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
  if (last === -1) return raw;
  const tail = raw.slice(last + 1);
  const head = raw.slice(0, last);
  const otherKind = /[.,]/.test(head);
  // Three digits after the only separator is a thousands separator ("1,299"); anything else a decimal.
  if (tail.length === 3 && !otherKind) return raw.replace(/[.,]/g, "");
  return `${head.replace(/[.,]/g, "")}.${tail}`;
}

function currenciesOf(mark: string): string[] {
  const symbol = SYMBOLS[mark];
  return symbol !== undefined ? [...symbol] : [mark.toLowerCase()];
}

/** Every amount written with a currency symbol or code, in order of appearance. */
export function findAmounts(text: string): ShownAmount[] {
  const found: { index: number; end: number; amount: ShownAmount }[] = [];
  for (const m of text.matchAll(PREFIXED))
    found.push({
      index: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      amount: {
        text: plainNumber(m[2] ?? ""),
        shown: m[0].trim(),
        currencies: currenciesOf(m[1] ?? ""),
      },
    });
  for (const m of text.matchAll(SUFFIXED)) {
    const index = m.index ?? 0;
    const end = index + m[0].length;
    if (found.some((f) => index < f.end && end > f.index)) continue;
    found.push({
      index,
      end,
      amount: {
        text: plainNumber(m[1] ?? ""),
        shown: m[0].trim(),
        currencies: currenciesOf(m[2] ?? ""),
      },
    });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.amount);
}

// ---- offers -------------------------------------------------------------------------------------

const PROMO = new RegExp(
  `\\b(?:coupon|cupon|promo\\w*|discount|descuento|intro(?:ductory|ductorio)?|off|save|ahorra\\w*|(?:first|primer[oa]?)\\s+(?:\\d+\\s+)?(?:${UNITS}))\\b`,
);

/** The text talks about an introductory price, a coupon or a discount (trial phrases set aside). */
export function hasPromoWords(text: string): boolean {
  const f = fold(text);
  return PROMO.test(without(f, trialSpans(f)));
}
