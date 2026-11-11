import { findDates, isoOfDay, resolveEnd, type Day, type FoundDate } from "./parse.js";
import { alternation, wordsFor } from "./words.js";

export interface StaleOptions {
  /** Languages beyond English to read. */
  langs: readonly string[];
  /** The run's date, in the venue's time zone. */
  today: Day;
  /** A date is flagged only when it is more than this many days past. */
  graceDays: number;
  /** A sentence containing any of these (without regard to case) is never flagged. */
  ignore: readonly string[];
}

export interface StaleHit {
  sentence: string;
  /** The last day the date covers, YYYY-MM-DD. */
  date: string;
  /** The date as written. */
  raw: string;
  daysAgo: number;
}

/** How far, in characters, a promotional word may be from a date that has a year. */
const PROMO_REACH = 40;
/** The longest sentence kept as evidence. */
const SENTENCE_MAX = 160;
/** A block ends a sentence, and so does ". " before a capital letter ("Oct. 31" is not an end). */
const BOUNDARY = /\n|[.!?](?=\s+[\p{Lu}¿¡])/gu;

interface Patterns {
  endBefore: RegExp;
  afterEnd: RegExp;
  lead: RegExp;
  promo: RegExp;
}

const cache = new Map<string, Patterns>();

function patternsFor(langs: readonly string[]): Patterns {
  const key = [...langs].sort().join(",");
  const hit = cache.get(key);
  if (hit) return hit;
  const w = wordsFor(langs);
  const word = (inner: string) => `(?<![\\p{L}\\p{N}'’])(?:${inner})`;
  const p: Patterns = {
    endBefore: new RegExp(
      `${word(alternation(w.endWords))}(?:\\s+(?:${alternation(w.fillers)})){0,3}\\s*[:,-]?\\s*$`,
      "iu",
    ),
    afterEnd: new RegExp(`^\\s*[,.)]?\\s*(?:${alternation(w.afterEnd)})(?![\\p{L}\\p{N}])`, "iu"),
    lead: new RegExp(`(?:${word(alternation(w.leads))}|©)\\s*[:.,]?\\s*$`, "iu"),
    promo: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation(w.promo)})(?![\\p{L}\\p{N}])`, "iu"),
  };
  cache.set(key, p);
  return p;
}

/** The sentence a span sits in: bounded by line breaks and full stops, and cut around the date when long. */
export function sentenceAround(text: string, start: number, end: number): string {
  const lo = Math.max(0, start - 240);
  const slice = text.slice(lo, Math.min(text.length, end + 240));
  let from = 0;
  let to = slice.length;
  for (const m of slice.matchAll(BOUNDARY)) {
    const at = m.index + (m[0] === "\n" ? 0 : 1);
    if (at <= start - lo) from = at + (m[0] === "\n" ? 1 : 0);
    else {
      to = at;
      break;
    }
  }
  let a = from;
  let b = to;
  if (b - a > SENTENCE_MAX) {
    a = Math.max(a, start - lo - 80);
    b = Math.min(b, end - lo + 80);
  }
  return slice.slice(a, b).replace(/\s+/g, " ").trim();
}

/**
 * The dates in a text that have passed while a promotion or notice still points at them. A date counts
 * when it is past by more than graceDays and either (a) it sits right after an end word ("through",
 * "until", "ends", "last day", "hasta"), or ends a range, or is followed by "only": a date with no year
 * is flagged on that alone, one with a year also needs a promotional word beside it; or (b) it has a
 * year, no "since", "established" or "published" in front of it, and a promotional word within
 * 40 characters ("Summer 2025 menu"). A date with no year and no end word is never flagged.
 */
export function staleCopy(text: string, opts: StaleOptions): StaleHit[] {
  const dates = findDates(text, opts.langs);
  const p = patternsFor(opts.langs);
  const ignore = opts.ignore.map((s) => s.toLowerCase()).filter((s) => s !== "");
  const out: StaleHit[] = [];
  const seen = new Set<string>();
  dates.forEach((f: FoundDate, i) => {
    const end = resolveEnd(f, opts.today);
    if (end === undefined || opts.today - end <= opts.graceDays) return;
    const before = text.slice(Math.max(0, f.start - 48), f.start);
    const after = text.slice(f.end, f.end + 40);
    const prev = dates[i - 1];
    const rangeEnd =
      prev !== undefined &&
      f.start - prev.end <= 8 &&
      /^\s*(?:-|–|—|to|al|au|a)\s*$/iu.test(text.slice(prev.end, f.start));
    const ended = p.endBefore.test(before) || p.afterEnd.test(after) || rangeEnd;
    if (f.kind === "month" && !ended) return;
    if (!ended && (!f.hasYear || p.lead.test(before))) return;
    const sentence = sentenceAround(text, f.start, f.end);
    const lower = sentence.toLowerCase();
    if (ignore.some((s) => lower.includes(s))) return;
    if (f.hasYear) {
      const near = text.slice(Math.max(0, f.start - PROMO_REACH), f.end + PROMO_REACH);
      if (!p.promo.test(near)) return;
    }
    const key = `${sentence}|${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sentence, date: isoOfDay(end), raw: f.raw, daysAgo: opts.today - end });
  });
  return out;
}
