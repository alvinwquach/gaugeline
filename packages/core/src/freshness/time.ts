import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { isTimeZone, localDate, wallTimeAt, zonedToUtc } from "../ics/time.js";

/**
 * Reading when a page says it was updated, and how long ago that is. All of it is integer
 * milliseconds: a duration is a count, an instant is a count since 1970, and "between 3 and 4 hours
 * ago" is two of them. Nothing here reads the machine's clock or its time zone; the run's clock and
 * the site's zone come in as arguments.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
  w: 7 * DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
};

/** The longest duration a rule may name. */
export const MAX_DURATION_MS = 400 * DAY;

/** "6h", "2d", "90m", "1w", "45s" (or the words: "6 hours") as milliseconds, or undefined. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d{1,6})\s*([a-z]+)$/i.exec(text.trim());
  if (!m) return undefined;
  const unit = UNITS[(m[2] ?? "").toLowerCase()];
  const n = Number(m[1]);
  if (unit === undefined || n === 0) return undefined;
  const ms = n * unit;
  return ms <= MAX_DURATION_MS ? ms : undefined;
}

export interface ActiveWhen {
  /** Months of the year, 1 to 12, in the site's time zone. October to June is [10, 11, 12, 1, 2, 3, 4, 5, 6]. */
  months: number[];
}

/**
 * Whether a rule is in force at an instant. The month is the month in the site's own time zone, so
 * the window turns over at the site's midnight and a window that runs across new year needs no
 * special case: it is a set of months, not a range.
 */
export function isActive(window: ActiveWhen | undefined, at: number, timeZone: string): boolean {
  if (!window) return true;
  return window.months.includes(wallTimeAt(at, timeZone).month);
}

/**
 * When something happened, as the earliest and latest instants it could mean. A stamp with a zone
 * is one instant (both are equal); "3 hours ago" is a span of an hour; a date with no time is a
 * day; a time with no zone, when the site's zone is not known, could be any zone on Earth.
 * Comparing a span with a limit is only a finding when it is wrong at both ends.
 */
export interface Moment {
  earliest: number;
  latest: number;
  /** exact: one instant. date: a day. relative: "3 hours ago". no-zone: a time whose zone is unknown. */
  kind: "exact" | "date" | "relative" | "no-zone";
}

export type MomentResult = { ok: true; moment: Moment } | { ok: false; reason: string };

export interface MomentOptions {
  /** The run's clock, in ms. */
  now: number;
  /** The site's IANA zone, for stamps that do not state one. */
  timeZone?: string;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function monthNumber(word: string): number | undefined {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w) && w.length <= 4));
  if (w === "sept") return 9;
  return i === -1 ? undefined : i + 1;
}

/** US zone abbreviations, in hours from UTC. Others are written as +hh:mm. */
const ABBREVIATIONS: Record<string, number> = {
  z: 0,
  utc: 0,
  gmt: 0,
  est: -5,
  edt: -4,
  cst: -6,
  cdt: -5,
  mst: -7,
  mdt: -6,
  pst: -8,
  pdt: -7,
};

/** The offset a zone token states, in ms, or undefined when it is not a zone. */
function offsetOf(token: string): number | undefined {
  const t = token.trim().toLowerCase();
  if (t in ABBREVIATIONS) return (ABBREVIATIONS[t] ?? 0) * HOUR;
  const m = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(t);
  if (!m) return undefined;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? 0);
  if (hours > 14 || minutes > 59) return undefined;
  return (m[1] === "-" ? -1 : 1) * (hours * HOUR + minutes * MINUTE);
}

function validDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  /** undefined: a date with no time. */
  time?: { h: number; mi: number; s: number };
  /** undefined: no zone stated. */
  offset?: number;
}

/** The widest offsets on Earth: UTC-12 to UTC+14. */
const EASTMOST = 14 * HOUR;
const WESTMOST = 12 * HOUR;

function fromParts(p: Parts, timeZone: string | undefined): Moment {
  const wall = { year: p.y, month: p.mo, day: p.d };
  if (p.time) {
    const w = { ...wall, hour: p.time.h, minute: p.time.mi, second: p.time.s };
    if (p.offset !== undefined) {
      const at = Date.UTC(p.y, p.mo - 1, p.d, p.time.h, p.time.mi, p.time.s) - p.offset;
      return { earliest: at, latest: at, kind: "exact" };
    }
    if (timeZone) {
      const at = zonedToUtc(w, timeZone);
      return { earliest: at, latest: at, kind: "exact" };
    }
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.time.h, p.time.mi, p.time.s);
    return { earliest: asUtc - EASTMOST, latest: asUtc + WESTMOST, kind: "no-zone" };
  }
  // A date with no time is the whole day.
  if (p.offset !== undefined) {
    const start = Date.UTC(p.y, p.mo - 1, p.d) - p.offset;
    return { earliest: start, latest: start + DAY - 1, kind: "date" };
  }
  if (timeZone) {
    const start = zonedToUtc({ ...wall, hour: 0, minute: 0 }, timeZone);
    const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    const end = zonedToUtc(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        hour: 0,
        minute: 0,
      },
      timeZone,
    );
    return { earliest: start, latest: end - 1, kind: "date" };
  }
  const start = Date.UTC(p.y, p.mo - 1, p.d);
  return { earliest: start - EASTMOST, latest: start + DAY - 1 + WESTMOST, kind: "no-zone" };
}

/** "Updated:", "Last updated", "Refreshed" and the like at the front of a stamp. */
const LABEL =
  /^(?:last\s+)?(?:updated|refreshed|synced|synchroni[sz]ed|modified|posted|as of)\s*:?\s*/i;

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(z|utc|gmt|[+-]\d{2}(?::?\d{2})?)?)?$/i;

const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?`;
const ZONE = String.raw`(z|utc|gmt|[ecmp][sd]t|[+-]\d{2}(?::?\d{2})?)`;
const DAYNAME = String.raw`(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+)?`;
const MONTH_FIRST = new RegExp(
  `^${DAYNAME}([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?:,?\\s+(?:at\\s+)?${CLOCK})?(?:\\s*${ZONE})?$`,
  "i",
);
const DAY_FIRST = new RegExp(
  `^${DAYNAME}(\\d{1,2})(?:st|nd|rd|th)?\\s+([a-z]{3,9})\\.?,?\\s+(\\d{4})(?:,?\\s+(?:at\\s+)?${CLOCK})?(?:\\s*${ZONE})?$`,
  "i",
);
const HTTP_DATE = new RegExp(
  `^${DAYNAME}(\\d{1,2})\\s+([a-z]{3})\\s+(\\d{4})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s*${ZONE}$`,
  "i",
);

function clock(
  h: string | undefined,
  mi: string | undefined,
  s: string | undefined,
  ampm: string | undefined,
): Parts["time"] {
  if (h === undefined) return undefined;
  let hour = Number(h);
  const minute = Number(mi ?? 0);
  const second = Number(s ?? 0);
  if (ampm) {
    if (hour < 1 || hour > 12) return { h: 99, mi: 0, s: 0 };
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  return { h: hour, mi: minute, s: second };
}

function wellFormed(p: Parts): boolean {
  if (!validDate(p.y, p.mo, p.d)) return false;
  if (!p.time) return true;
  return p.time.h < 24 && p.time.mi < 60 && p.time.s < 60;
}

const RELATIVE_UNITS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: MINUTE,
  min: MINUTE,
  hour: HOUR,
  hr: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  year: 365 * DAY,
  s: 1000,
  m: MINUTE,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
};

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1 };

function relative(text: string, now: number): Moment | undefined {
  if (/^(?:just now|now|a moment ago|moments? ago|(?:a few )?seconds? ago)$/.test(text))
    return { earliest: now - MINUTE, latest: now, kind: "relative" };
  const m =
    /^(?:about |around |over |almost |nearly )?(a|an|one|\d{1,6})\s*([a-z]+?)s?\s+ago$/.exec(text);
  if (!m) return undefined;
  const unit = RELATIVE_UNITS[m[2] ?? ""];
  const n = NUMBER_WORDS[m[1] ?? ""] ?? Number(m[1]);
  if (unit === undefined || !Number.isFinite(n) || n < 0) return undefined;
  return { earliest: now - (n + 1) * unit, latest: now - n * unit, kind: "relative" };
}

/**
 * Turn the text a page shows as its update time into a span of instants. It understands the forms
 * sites actually print (ISO 8601 and RFC 3339, HTTP dates, epoch seconds and milliseconds, English
 * dates like "Nov 9, 2026 4:30 PM EST", and "3 hours ago") and refuses everything else with a
 * reason: a stamp that is not understood is "could not check", never a guess.
 */
export function parseMoment(raw: string, opts: MomentOptions): MomentResult {
  const timeZone = opts.timeZone && isTimeZone(opts.timeZone) ? opts.timeZone : undefined;
  const text = raw
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const unreadable = (): MomentResult => ({
    ok: false,
    reason:
      text === "" ? "the stamp is empty" : `could not read "${escapeInvisible(raw, 40)}" as a date`,
  });
  if (text === "") return unreadable();
  const body = text.replace(LABEL, "");

  if (/^\d{10}$/.test(body) || /^\d{13}$/.test(body)) {
    const at = body.length === 10 ? Number(body) * 1000 : Number(body);
    return { ok: true, moment: { earliest: at, latest: at, kind: "exact" } };
  }

  const rel = relative(body.toLowerCase(), opts.now);
  if (rel) return { ok: true, moment: rel };
  if (body.toLowerCase() === "today" || body.toLowerCase() === "yesterday") {
    const back = body.toLowerCase() === "today" ? 0 : DAY;
    const [y, mo, d] = (
      timeZone ? localDate(opts.now - back, timeZone) : new Date(opts.now - back).toISOString()
    )
      .slice(0, 10)
      .split("-")
      .map(Number);
    if (y === undefined || mo === undefined || d === undefined) return unreadable();
    return { ok: true, moment: fromParts({ y, mo, d }, timeZone) };
  }

  let parts: Parts | undefined;
  const iso = ISO.exec(body);
  if (iso) {
    const time =
      iso[4] === undefined
        ? undefined
        : { h: Number(iso[4]), mi: Number(iso[5]), s: Number(iso[6] ?? 0) };
    const offset = iso[7] === undefined ? undefined : offsetOf(iso[7]);
    if (iso[7] !== undefined && offset === undefined) return unreadable();
    parts = {
      y: Number(iso[1]),
      mo: Number(iso[2]),
      d: Number(iso[3]),
      ...(time ? { time } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
  } else {
    const http = HTTP_DATE.exec(body);
    const first = MONTH_FIRST.exec(body);
    const day = DAY_FIRST.exec(body);
    const hit = http ?? first ?? day;
    if (hit) {
      const [month, d, y]: [string | undefined, string | undefined, string | undefined] = http
        ? [hit[2], hit[1], hit[3]]
        : first
          ? [hit[1], hit[2], hit[3]]
          : [hit[2], hit[1], hit[3]];
      const mo = month === undefined ? undefined : monthNumber(month);
      const time = http
        ? { h: Number(hit[4]), mi: Number(hit[5]), s: Number(hit[6]) }
        : clock(hit[4], hit[5], hit[6], hit[7]);
      const zone = http ? hit[7] : hit[8];
      const offset = zone === undefined ? undefined : offsetOf(zone);
      if (mo === undefined || (zone !== undefined && offset === undefined)) return unreadable();
      parts = {
        y: Number(y),
        mo,
        d: Number(d),
        ...(time ? { time } : {}),
        ...(offset !== undefined ? { offset } : {}),
      };
    }
  }
  if (!parts || !wellFormed(parts)) return unreadable();
  return { ok: true, moment: fromParts(parts, timeZone) };
}
