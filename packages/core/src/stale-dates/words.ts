import data from "../data/stale-dates.json";

/** The words of one language, from packages/core/src/data/stale-dates.json. */
export interface LanguageWords {
  months: ReadonlyMap<string, number>;
  seasons: ReadonlyMap<string, Season>;
  endWords: readonly string[];
  afterEnd: readonly string[];
  fillers: readonly string[];
  leads: readonly string[];
  promo: readonly string[];
}

export type Season = "spring" | "summer" | "fall" | "winter";

type Raw = {
  months: Record<string, number>;
  seasons: Record<string, Season>;
  endWords: string[];
  afterEnd: string[];
  fillers: string[];
  leads: string[];
  promo: string[];
};

/** Languages with word lists. English is always read; the others when a site says it uses them. */
export const STALE_LANGUAGES: readonly string[] = Object.freeze(Object.keys(data.languages));

/** Words merged across the languages a run reads. Maps and Sets, so a word like "constructor" is only ever a word. */
export function wordsFor(langs: readonly string[]): LanguageWords {
  const picked = ["en", ...langs.filter((l) => l !== "en")].filter((l, i, a) => a.indexOf(l) === i);
  const raws = picked
    .filter((l) => (STALE_LANGUAGES as readonly string[]).includes(l))
    .map((l) => (data.languages as unknown as Record<string, Raw>)[l] as Raw);
  const months = new Map<string, number>();
  const seasons = new Map<string, Season>();
  for (const r of raws) {
    for (const [k, v] of Object.entries(r.months)) if (!months.has(k)) months.set(k, v);
    for (const [k, v] of Object.entries(r.seasons)) if (!seasons.has(k)) seasons.set(k, v);
  }
  const list = (pick: (r: Raw) => string[]) => [...new Set(raws.flatMap(pick))];
  return {
    months,
    seasons,
    endWords: list((r) => r.endWords),
    afterEnd: list((r) => r.afterEnd),
    fillers: list((r) => r.fillers),
    leads: list((r) => r.leads),
    promo: list((r) => r.promo),
  };
}

/** The structured-data types of a page that is a record of the past, lower case. */
export const HISTORIC_TYPES: ReadonlySet<string> = new Set(data.historicTypes);

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** A word as regular-expression text: escaped, with spaces matching any run of whitespace. Longest first by the caller. */
export function wordPattern(word: string): string {
  return word.replace(SPECIAL, "\\$&").replace(/ +/g, "\\s+");
}

/** An alternation of words, longest first so "valid until" wins over "until". */
export function alternation(words: Iterable<string>): string {
  return [...words]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map(wordPattern)
    .join("|");
}
