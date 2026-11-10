/** A date the site says the business is closed, and how it says so. */
export interface Closure {
  /** YYYY-MM-DD. */
  date: string;
  /** What the site calls it: "Thanksgiving", "Nov 26". */
  label: string;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const YEAR = "(?:,?\\s+(20\\d{2}))?";
const DATE = new RegExp(
  `\\b(?:${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?${YEAR}|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?${YEAR})(?!\\d)`,
  "gi",
);

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** The nth (1-based) weekday of a month; weekday 0 is Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastMonday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() + 6) % 7);
}

/** Holidays that fall on one day every year in the United States, by the words a menu uses. */
const HOLIDAYS: { pattern: string; label: string; on: (year: number) => string }[] = [
  {
    pattern: "thanksgiving(?:\\s+day)?",
    label: "Thanksgiving",
    on: (y) => iso(y, 11, nthWeekday(y, 11, 4, 4)),
  },
  { pattern: "christmas\\s+eve", label: "Christmas Eve", on: (y) => iso(y, 12, 24) },
  { pattern: "christmas(?:\\s+day)?", label: "Christmas Day", on: (y) => iso(y, 12, 25) },
  { pattern: "new\\s+year'?s\\s+eve", label: "New Year's Eve", on: (y) => iso(y, 12, 31) },
  { pattern: "new\\s+year'?s(?:\\s+day)?", label: "New Year's Day", on: (y) => iso(y, 1, 1) },
  {
    pattern: "(?:independence\\s+day|(?:the\\s+)?(?:4th|fourth)\\s+of\\s+july|july\\s+4(?:th)?)",
    label: "Independence Day",
    on: (y) => iso(y, 7, 4),
  },
  { pattern: "memorial\\s+day", label: "Memorial Day", on: (y) => iso(y, 5, lastMonday(y, 5)) },
  { pattern: "labou?r\\s+day", label: "Labor Day", on: (y) => iso(y, 9, nthWeekday(y, 9, 1, 1)) },
];
const HOLIDAY = new RegExp(`\\b(${HOLIDAYS.map((h) => `(${h.pattern})`).join("|")})\\b`, "gi");

/** Words between "closed" and a date that mean the date is when it opens again, not a closure. */
const REOPENS =
  /\b(?:open|opens|opening|reopen\w*|re-open\w*|until|through|thru|from|starting|begin\w*|resum\w*|return\w*)\b/i;
/** How far, in characters, a date may be from the word "closed" and still be about it. */
const REACH = 40;

interface Candidate {
  at: number;
  end: number;
  label: string;
  /** Resolves the date relative to today (YYYY-MM-DD). */
  resolve: (today: string) => string;
}

function nextOccurrence(today: string, month: number, day: number): string {
  const year = Number(today.slice(0, 4));
  const here = iso(year, month, day);
  return here >= today ? here : iso(year + 1, month, day);
}

function candidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(DATE)) {
    const month = MONTHS[(m[1] ?? m[5] ?? "").toLowerCase()];
    const day = Number(m[2] ?? m[4]);
    const year = m[3] ?? m[6];
    if (!month || day < 1 || day > 31) continue;
    out.push({
      at: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      label: m[0].trim(),
      resolve: (today) =>
        year ? iso(Number(year), month, day) : nextOccurrence(today, month, day),
    });
  }
  for (const m of text.matchAll(HOLIDAY)) {
    const index = m.slice(2).findIndex((g) => g !== undefined);
    const holiday = HOLIDAYS[index];
    if (!holiday) continue;
    out.push({
      at: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      label: holiday.label,
      resolve: (today) => {
        const year = Number(today.slice(0, 4));
        const here = holiday.on(year);
        return here >= today ? here : holiday.on(year + 1);
      },
    });
  }
  return out;
}

/**
 * The closures a page's text announces: "Closed Thanksgiving Day", "Closed on December 25",
 * "Nov 26: closed". A date counts when it is within 40 characters of the word "closed", is the
 * nearest date to it, and has no "open", "until" or "from" between them ("Closed Mondays, reopening
 * December 1" is not a closure on December 1). A date with no year is its next occurrence on or
 * after `today`.
 */
export function closuresInText(text: string, today: string): Closure[] {
  const found = candidates(text);
  const seen = new Map<string, Closure>();
  for (const word of text.matchAll(/\bclosed\b/gi)) {
    const at = word.index ?? 0;
    const wordEnd = at + word[0].length;
    let best: { c: Candidate; gap: number } | undefined;
    for (const c of found) {
      const gap = c.at >= wordEnd ? c.at - wordEnd : at >= c.end ? at - c.end : 0;
      if (gap > REACH) continue;
      const between = c.at >= wordEnd ? text.slice(wordEnd, c.at) : text.slice(c.end, at);
      if (REOPENS.test(between)) continue;
      if (!best || gap < best.gap || (gap === best.gap && c.at >= wordEnd)) best = { c, gap };
    }
    if (!best) continue;
    // "Closed Christmas Eve and Christmas Day": the dates joined to the first by a comma or "and".
    const chain = [best.c];
    if (best.c.at >= wordEnd) {
      for (const c of [...found].sort((a, b) => a.at - b.at)) {
        const last = chain[chain.length - 1] as Candidate;
        if (
          c.at >= last.end &&
          /^[\s,&]*(?:(?:and|or)[\s,]+)?(?:(?:on|for)\s+)?$/i.test(text.slice(last.end, c.at))
        )
          chain.push(c);
      }
    }
    for (const c of chain) {
      const date = c.resolve(today);
      if (!seen.has(date)) seen.set(date, { date, label: c.label });
    }
  }
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}
