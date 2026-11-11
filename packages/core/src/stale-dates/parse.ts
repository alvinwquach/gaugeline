import { alternation, wordsFor, type LanguageWords, type Season } from "./words.js";

/** A day as a whole number of days since 1970-01-01 (UTC). Integers, so two days compare and subtract exactly. */
export type Day = number;

const MS_PER_DAY = 86_400_000;
/** The most text read for dates, and the most dates kept from it. Linear in the text, bounded in the output. */
const MAX_TEXT = 200_000;
const MAX_DATES = 400;

/** The day number of a real calendar date, or undefined for one that does not exist (30 February). */
export function dayNumber(year: number, month: number, date: number): Day | undefined {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return undefined;
  const ms = Date.UTC(year, month - 1, date);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== date)
    return undefined;
  return Math.floor(ms / MS_PER_DAY);
}

/** "2026-10-31". */
export function isoOfDay(day: Day): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

const lastOfMonth = (year: number, month: number): Day =>
  Math.floor(Date.UTC(year, month, 0) / MS_PER_DAY);

/** Today's calendar date in an IANA zone (the venue's), as a day number. An unknown zone reads as UTC. */
export function todayIn(now: Date, zone: string): Day {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return dayNumber(n("year"), n("month"), n("day")) ?? Math.floor(now.getTime() / MS_PER_DAY);
}

export type DateKind = "full" | "month-day" | "month-year" | "season-year" | "month" | "numeric";

/** A date written in the text: where, how it was written and what it means. */
export interface FoundDate {
  /** Offsets into the text searched, end exclusive. */
  start: number;
  end: number;
  raw: string;
  kind: DateKind;
  /** Written with a year (full, month-year, season-year, or numeric with one). */
  hasYear: boolean;
  year?: number;
  month?: number;
  date?: number;
  season?: Season;
}

const MONTH_NAME_END = "(?![\\p{L}\\p{N}])";
const BEFORE = "(?<![\\p{L}\\p{N}])";
const APOS = "['\u2019]";

interface Scanner {
  words: LanguageWords;
  monthFirst: RegExp;
  dayFirst: RegExp;
  monthYear: RegExp;
  seasonYear: RegExp;
  monthAlone: RegExp;
  numeric: RegExp;
  iso: RegExp;
  dotted: RegExp;
}

const scanners = new Map<string, Scanner>();

function scannerFor(langs: readonly string[]): Scanner {
  const key = [...langs].sort().join(",");
  const hit = scanners.get(key);
  if (hit) return hit;
  const words = wordsFor(langs);
  const M = alternation(words.months.keys());
  const S = alternation(words.seasons.keys());
  const E = alternation(words.endWords);
  const F = alternation(words.fillers);
  const s: Scanner = {
    words,
    monthFirst: new RegExp(
      `${BEFORE}(${M})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th|\u00BA)?(?![\\d:])(?:,?\\s+(\\d{4})(?!\\d))?`,
      "giud",
    ),
    dayFirst: new RegExp(
      `(?<![\\p{L}\\p{N}/.-])(\\d{1,2})(?:st|nd|rd|th|\u00BA|er)?\\s+(?:(?:of|de|del)\\s+)?(${M})${MONTH_NAME_END}\\.?(?:,?\\s+(?:(?:de|del)\\s+)?(\\d{4})(?!\\d))?`,
      "giud",
    ),
    monthYear: new RegExp(
      `${BEFORE}(${M})\\.?,?\\s+(?:de\\s+)?(?:(\\d{4})(?!\\d)|${APOS}(\\d{2})(?!\\d))`,
      "giud",
    ),
    seasonYear: new RegExp(
      `${BEFORE}(${S})\\s+(?:(?:of|de)\\s+)?(?:(\\d{4})(?!\\d)|${APOS}(\\d{2})(?!\\d))`,
      "giud",
    ),
    monthAlone: new RegExp(
      `(?<![\\p{L}\\p{N}'\u2019])(?:${E})\\s+(?:(?:${F})\\s+){0,3}(${M})${MONTH_NAME_END}(?!\\.?\\s*\\d)`,
      "giud",
    ),
    numeric: /(?<![\p{N}/.:-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/dgu,
    iso: /(?<![\p{N}-])(\d{4})-(\d{2})-(\d{2})(?!\d)/dgu,
    dotted: /(?<![\p{N}.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/dgu,
  };
  scanners.set(key, s);
  return s;
}

const twoDigit = (y: string) => 2000 + Number(y);

/**
 * Every date written in the text, in order, by plain patterns (no model, no guessing): "Oct 31",
 * "October 31, 2025", "31 de octubre", "10/31", "2025-10-31", "Summer 2025", "Fall '25", "November 2025",
 * and a bare month after an end word ("through September"). `langs` are the languages beyond English
 * to read. A numeric date that could be day-first or month-first ("10/11") is left out, as is "24/7".
 * A date that does not exist (30 February) is left out. The patterns are linear in the text; the text
 * is cut at 200,000 characters and at most 400 dates are returned.
 */
export function findDates(text: string, langs: readonly string[] = []): FoundDate[] {
  const s = scannerFor(langs);
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const found: FoundDate[] = [];
  const month = (name: string | undefined) => s.words.months.get((name ?? "").toLowerCase());
  const push = (
    m: RegExpExecArray,
    f: Omit<FoundDate, "start" | "end" | "raw"> & { at?: number },
  ) => {
    const start = f.at ?? m.index;
    const end = m.index + m[0].length;
    const { at: _at, ...rest } = f;
    found.push({ ...rest, start, end, raw: t.slice(start, end) });
  };
  const valid = (y: number | undefined, mo: number | undefined, d: number | undefined) =>
    mo !== undefined &&
    d !== undefined &&
    d >= 1 &&
    d <= 31 &&
    (y === undefined ? dayNumber(2024, mo, d) !== undefined : dayNumber(y, mo, d) !== undefined);

  for (const m of t.matchAll(s.monthFirst)) {
    const mo = month(m[1]);
    const d = Number(m[2]);
    const y = m[3] === undefined ? undefined : Number(m[3]);
    if (!valid(y, mo, d)) continue;
    push(m, {
      kind: y === undefined ? "month-day" : "full",
      hasYear: y !== undefined,
      ...(y === undefined ? {} : { year: y }),
      month: mo!,
      date: d,
    });
  }
  for (const m of t.matchAll(s.dayFirst)) {
    const mo = month(m[2]);
    const d = Number(m[1]);
    const y = m[3] === undefined ? undefined : Number(m[3]);
    if (!valid(y, mo, d)) continue;
    push(m, {
      kind: y === undefined ? "month-day" : "full",
      hasYear: y !== undefined,
      ...(y === undefined ? {} : { year: y }),
      month: mo!,
      date: d,
    });
  }
  for (const m of t.matchAll(s.monthYear)) {
    const mo = month(m[1]);
    const y = m[2] !== undefined ? Number(m[2]) : twoDigit(m[3] ?? "0");
    if (mo === undefined || dayNumber(y, mo, 1) === undefined) continue;
    push(m, { kind: "month-year", hasYear: true, year: y, month: mo });
  }
  for (const m of t.matchAll(s.seasonYear)) {
    const season = s.words.seasons.get((m[1] ?? "").toLowerCase());
    const y = m[2] !== undefined ? Number(m[2]) : twoDigit(m[3] ?? "0");
    if (season === undefined || dayNumber(y, 1, 1) === undefined) continue;
    push(m, { kind: "season-year", hasYear: true, year: y, season });
  }
  for (const m of t.matchAll(s.iso)) {
    const y = Number(m[1]);
    if (dayNumber(y, Number(m[2]), Number(m[3])) === undefined) continue;
    push(m, { kind: "numeric", hasYear: true, year: y, month: Number(m[2]), date: Number(m[3]) });
  }
  for (const m of t.matchAll(s.dotted)) {
    const y = Number(m[3]);
    if (dayNumber(y, Number(m[2]), Number(m[1])) === undefined) continue;
    push(m, { kind: "numeric", hasYear: true, year: y, month: Number(m[2]), date: Number(m[1]) });
  }
  for (const m of t.matchAll(s.numeric)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = m[3] === undefined ? undefined : m[3].length === 4 ? Number(m[3]) : twoDigit(m[3]);
    // One order must be impossible for the other to be certain. With no year only month/day is read:
    // "24/7" is "open all day", not the 24th of July.
    let mo: number | undefined;
    let d: number | undefined;
    if (a <= 12 && b > 12) [mo, d] = [a, b];
    else if (a > 12 && b <= 12 && y !== undefined) [mo, d] = [b, a];
    if (!valid(y, mo, d)) continue;
    push(m, {
      kind: "numeric",
      hasYear: y !== undefined,
      ...(y === undefined ? {} : { year: y }),
      month: mo!,
      date: d!,
    });
  }
  for (const m of t.matchAll(s.monthAlone)) {
    const name = m[1] ?? "";
    // "may" is a verb unless it is written as the month.
    if (name.toLowerCase() === "may" && name !== "May") continue;
    const mo = month(name);
    const at = (m.indices?.[1]?.[0] ?? m.index) as number;
    if (mo === undefined) continue;
    push(m, { kind: "month", hasYear: false, month: mo, at });
  }

  // Overlaps (the same text read two ways) keep the longest reading that starts first.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: FoundDate[] = [];
  let reach = -1;
  for (const f of found) {
    if (f.start < reach) continue;
    out.push(f);
    reach = f.end;
    if (out.length >= MAX_DATES) break;
  }
  return out;
}

/** The nearest of the years around today: ties go to the later one, which is not yet past. */
function nearest(today: Day, at: (year: number) => Day | undefined): Day | undefined {
  const year = Number(isoOfDay(today).slice(0, 4));
  let best: Day | undefined;
  for (const y of [year - 1, year, year + 1, year + 2, year - 2]) {
    const d = at(y);
    if (d === undefined) continue;
    if (best === undefined) best = d;
    else {
      const a = Math.abs(d - today);
      const b = Math.abs(best - today);
      if (a < b || (a === b && d > best)) best = d;
    }
  }
  return best;
}

/**
 * The last day the date covers. A day is that day, a month is its last day, a season is the end of its
 * last month (winter ends in February of the next year). A month and day with no year, or a bare
 * month, is the occurrence nearest to today, so "Jan 3" in March is January just gone and in late
 * December is the January ahead.
 */
export function resolveEnd(f: FoundDate, today: Day): Day | undefined {
  switch (f.kind) {
    case "full":
    case "numeric":
    case "month-day":
      if (f.hasYear) return dayNumber(f.year as number, f.month as number, f.date as number);
      return nearest(today, (y) => dayNumber(y, f.month as number, f.date as number));
    case "month-year":
      return lastOfMonth(f.year as number, f.month as number);
    case "season-year": {
      const y = f.year as number;
      return f.season === "spring"
        ? lastOfMonth(y, 5)
        : f.season === "summer"
          ? lastOfMonth(y, 8)
          : f.season === "fall"
            ? lastOfMonth(y, 11)
            : lastOfMonth(y + 1, 2);
    }
    case "month":
      return nearest(today, (y) => lastOfMonth(y, f.month as number));
  }
}
