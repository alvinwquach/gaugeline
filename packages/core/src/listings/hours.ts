import { DAYS, DAY_EXPR, parseDays, parseTime, type Day } from "../facts/normalise.js";

/**
 * Opening hours as seven per-day lists of intervals, in the venue's local time. An interval is
 * [start, end) in minutes from midnight of the day it opens, so a bar that closes at 2am on Friday
 * night is [660, 1560] on Friday (11am to 26:00), never a stray piece on Saturday. An empty list is
 * a day that is closed; a day with no key is a day the source does not speak about.
 */
export type Interval = readonly [start: number, end: number];
export type DayHours = Partial<Record<Day, Interval[]>>;

const DAY_MINUTES = 1440;

/** Sorted, with touching and overlapping intervals joined: 11am-2pm then 2pm-2am is one shift. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** An open and a close given as wall-clock minutes; a close at or before the open is the next day. */
export function intervalFrom(open: number, close: number): Interval | undefined {
  if (open === close) return undefined;
  return [open, close > open ? close : close + DAY_MINUTES];
}

function sameIntervals(a: readonly Interval[], b: readonly Interval[]): boolean {
  const x = mergeIntervals(a);
  const y = mergeIntervals(b);
  return x.length === y.length && x.every((v, i) => v[0] === y[i]?.[0] && v[1] === y[i]?.[1]);
}

const TIME = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?|noon|midnight)(?![\\w:])";
const SEP = "\\s*(?:-|\u2013|\u2014|\\bto\\b)\\s*";
const RANGE = `${TIME}${SEP}${TIME}`;
const MORE = `\\s*(?:,|&|\\band\\b|\\+)\\s*`;
const SEGMENT = new RegExp(
  `\\b(${DAY_EXPR})\\b\\s*:?\\s*(closed|${RANGE}(?:${MORE}${RANGE})*)(?![\\w:])`,
  "gi",
);

function oneRange(text: string): Interval | undefined {
  const [a, b, ...rest] = text.split(new RegExp(SEP, "i"));
  if (a === undefined || b === undefined || rest.length > 0) return undefined;
  const open = parseTime(a);
  const close = parseTime(b);
  return open === undefined || close === undefined ? undefined : intervalFrom(open, close);
}

/**
 * Hours as a person writes them: "Mon closed; Tue-Thu 4pm-11pm; Fri-Sat 4pm-2am", split shifts as
 * "Tue 11am-2pm, 5pm-10pm". A day given two different answers is left out (two answers are not one
 * fact), and so is anything that does not parse: nothing is guessed.
 */
export function parseListedHours(text: string): DayHours {
  const seen = new Map<Day, Set<string>>();
  const found = new Map<string, Interval[]>();
  for (const m of text.matchAll(SEGMENT)) {
    const days = parseDays(m[1] ?? "");
    const body = (m[2] ?? "").trim();
    if (!days) continue;
    let list: Interval[] = [];
    if (!/^closed$/i.test(body)) {
      const parts = body.split(new RegExp(`(?<=[a-z\\d])${MORE}(?=\\d|noon|midnight)`, "i"));
      const ranges = parts.map(oneRange);
      if (ranges.some((r) => r === undefined)) continue;
      list = mergeIntervals(ranges as Interval[]);
    }
    const key = JSON.stringify(list);
    found.set(key, list);
    for (const d of days) {
      const set = seen.get(d) ?? new Set<string>();
      set.add(key);
      seen.set(d, set);
    }
  }
  const out: DayHours = {};
  for (const d of DAYS) {
    const set = seen.get(d);
    if (set && set.size === 1) out[d] = found.get([...set][0] ?? "") ?? [];
  }
  return out;
}

/** Add one interval to a day (structured sources give a split shift as two periods). */
export function addInterval(hours: DayHours, day: Day, interval: Interval | undefined): void {
  const list = hours[day] ?? [];
  if (interval) list.push(interval);
  hours[day] = mergeIntervals(list);
}

const DAY_LABEL: Record<Day, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export function dayLabel(day: Day): string {
  return DAY_LABEL[day];
}

function clock(minutes: number): string {
  const m = minutes % DAY_MINUTES;
  if (m === 0) return "midnight";
  if (m === 720) return "noon";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${mm === 0 ? "" : `:${String(mm).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

/** "11am-2am", "11:30am-2pm, 5pm-midnight", or "closed". */
export function describeDay(list: readonly Interval[]): string {
  if (list.length === 0) return "closed";
  return mergeIntervals(list)
    .map(([a, b]) => `${clock(a)}-${clock(b)}`)
    .join(", ");
}

export interface DayDifference {
  day: Day;
  site: Interval[];
  listing: Interval[];
}

/**
 * The days the site states hours for where the listing's differ, in week order. A day the site
 * does not mention is not compared. A listing that gave hours at all but has no entry for a day
 * is closed that day (that is how every source states it).
 */
export function compareHours(site: DayHours, listing: DayHours): DayDifference[] {
  return DAYS.flatMap((day) => {
    const wanted = site[day];
    if (wanted === undefined) return [];
    const got = listing[day] ?? [];
    return sameIntervals(wanted, got) ? [] : [{ day, site: wanted, listing: got }];
  });
}

/** "Saturday: Yelp says 11am-3am, your site says 11am-2am; Sunday: ...". */
export function describeHours(differences: readonly DayDifference[], who: string): string {
  return differences
    .map(
      (d) =>
        `${DAY_LABEL[d.day]}: ${who} says ${describeDay(d.listing)}, your site says ${describeDay(d.site)}`,
    )
    .join("; ");
}
