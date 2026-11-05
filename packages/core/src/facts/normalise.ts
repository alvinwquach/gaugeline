/**
 * Conservative normalisers for the facts an assistant quotes: phone numbers and opening hours.
 * Shared with X23 (facts that must match everywhere). Comparison is deliberately strict:
 * "5pm" equals "5:00 PM" and "17:00"; anything that does not parse is undefined (unchecked),
 * never a guess.
 */

/**
 * Digits of a phone number, for comparison. A North American number written with its country
 * code (+1 or a leading 1 on 11 digits) compares equal to the 10-digit form. Fewer than 7 or more
 * than 15 digits is not a phone number.
 */
/** E.164 allows at most 15 digits; fewer than 7 is a fragment, not a number. */
const PHONE_DIGITS = { min: 7, max: 15 } as const;

export function normalisePhone(text: string): string | undefined {
  const digits = text.replace(/^tel:/i, "").replace(/\D/g, "");
  if (digits.length < PHONE_DIGITS.min || digits.length > PHONE_DIGITS.max) return undefined;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

const DAY_NAMES: Record<string, Day> = {
  mo: "mon",
  mon: "mon",
  monday: "mon",
  tu: "tue",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  we: "wed",
  wed: "wed",
  weds: "wed",
  wednesday: "wed",
  th: "thu",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fr: "fri",
  fri: "fri",
  friday: "fri",
  sa: "sat",
  sat: "sat",
  saturday: "sat",
  su: "sun",
  sun: "sun",
  sunday: "sun",
};

/** "Monday", "Mon", "Mo", "https://schema.org/Monday" -> "mon". */
export function parseDay(text: string): Day | undefined {
  const word = text
    .trim()
    .replace(/^https?:\/\/schema\.org\//i, "")
    .replace(/\.$/, "");
  return DAY_NAMES[word.toLowerCase()];
}

/** "5pm", "5:00 PM", "17:00", "09:00:00", "noon", "midnight" -> minutes since midnight. */
export function parseTime(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/\./g, "");
  if (t === "noon") return 12 * 60;
  if (t === "midnight") return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3];
  if (minute > 59) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (hour === 12) hour = 0;
    if (meridiem.startsWith("p")) hour += 12;
  } else {
    // A bare "9" is ambiguous (9am or 9pm): unchecked. 24-hour times need minutes.
    if (m[2] === undefined || hour > 24) return undefined;
  }
  return hour * 60 + minute;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Opening hours by day: "09:00-17:00", or "closed". A day not mentioned is absent. */
export type Hours = Partial<Record<Day, string>>;

function daysBetween(from: Day, to: Day): Day[] {
  const a = DAYS.indexOf(from);
  const b = DAYS.indexOf(to);
  const out: Day[] = [];
  for (let i = a; ; i = (i + 1) % 7) {
    out.push(DAYS[i] as Day);
    if (i === b || out.length === 7) break;
  }
  return out;
}

/** "Mon-Fri", "Mon–Fri, Sun", "Sat & Sun", "Mo-Fr", "Monday to Friday" -> days. */
export function parseDays(text: string): Day[] | undefined {
  const out: Day[] = [];
  const plain = text.replace(/https?:\/\/schema\.org\//gi, "");
  for (const part of plain.split(/\s*(?:,|&|\band\b|\/)\s*/i)) {
    if (part.trim() === "") continue;
    const range = part.split(/\s*(?:-|–|—|\bto\b|\bthrough\b|\bthru\b)\s*/i);
    const from = parseDay(range[0] ?? "");
    if (!from) return undefined;
    if (range.length === 1) out.push(from);
    else if (range.length === 2) {
      const to = parseDay(range[1] ?? "");
      if (!to) return undefined;
      out.push(...daysBetween(from, to));
    } else return undefined;
  }
  return out.length > 0 ? [...new Set(out)] : undefined;
}

/** "9am-5pm", "9:00 AM – 5:00 PM", "09:00-17:00", "closed" -> "09:00-17:00" or "closed". */
export function parseTimeRange(text: string): string | undefined {
  const t = text.trim();
  if (/^closed$/i.test(t)) return "closed";
  const parts = t.split(/\s*(?:-|–|—|\bto\b)\s*/i);
  if (parts.length !== 2) return undefined;
  const open = parseTime(parts[0] ?? "");
  const close = parseTime(parts[1] ?? "");
  if (open === undefined || close === undefined) return undefined;
  return `${hhmm(open)}-${hhmm(close)}`;
}

const DAY_WORD =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|mo|tu|we|th|fr|sa|su)";
const DAY_EXPR = `${DAY_WORD}(?:\\s*(?:-|–|—|to|through|thru|,|&|and|/)\\s*${DAY_WORD})*`;
const TIME = "(?:\\d{1,2}(?::\\d{2}){0,2}\\s*(?:[ap]\\.?m?\\.?)?|noon|midnight)";
const RANGE = `(?:${TIME}\\s*(?:-|–|—|to)\\s*${TIME}|closed)`;
const HOURS_RE = new RegExp(`\\b(${DAY_EXPR})\\b\\s*:?\\s*(${RANGE})(?![\\w:])`, "gi");

/**
 * Every "days times" pair in free text, e.g. "Mon–Fri 8am–4pm, Sat 9am–2pm, Sun closed" or the
 * schema.org openingHours form "Mo-Fr 09:00-17:00". Pairs that do not parse are skipped. When a
 * day is given twice with different times, it is left out: two answers are not one fact.
 */
export function parseHoursText(text: string): Hours {
  const seen = new Map<Day, Set<string>>();
  for (const m of text.matchAll(HOURS_RE)) {
    const days = parseDays(m[1] ?? "");
    const range = parseTimeRange(m[2] ?? "");
    if (!days || !range) continue;
    for (const d of days) {
      const set = seen.get(d) ?? new Set<string>();
      set.add(range);
      seen.set(d, set);
    }
  }
  const out: Hours = {};
  for (const d of DAYS) {
    const set = seen.get(d);
    if (set && set.size === 1) out[d] = [...set][0];
  }
  return out;
}

/** Days present in both with different hours, in week order. */
export function hoursDisagree(a: Hours, b: Hours): { day: Day; a: string; b: string }[] {
  return DAYS.flatMap((day) => {
    const x = a[day];
    const y = b[day];
    return x !== undefined && y !== undefined && x !== y ? [{ day, a: x, b: y }] : [];
  });
}

/** "$5", "$5.00", "5 USD" and "5.00" are one amount: cents, or undefined when there is no amount. */
export function normaliseAmount(text: string): number | undefined {
  const m = /(\d+)(?:[.,](\d{1,2}))?/.exec(text.replace(/,(?=\d{3}\b)/g, ""));
  if (!m) return undefined;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** A payment handle compared without its @ or $ and without letter case: "@Marigold-Pop" = "marigold-pop". */
export function normaliseHandle(text: string): string | undefined {
  const h = text.trim().replace(/^[@$]/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,40}$/.test(h) ? h : undefined;
}
