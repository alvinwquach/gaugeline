import type { IcsFile, IcsTime } from "./parse.js";
import { isTimeZone, localDate, wallTimeAt, zonedToUtc } from "./time.js";

/** How far ahead recurrences are expanded. It bounds the memory and the work per run. */
export const EXPAND_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

/** One dated occurrence, in the sorted array every events check reads. */
export interface Occurrence {
  /** The instant it starts (for an all-day event: local midnight, used only for ordering). */
  start: number;
  end?: number;
  /** The local date it starts on, in its zone: "2026-11-05". */
  date: string;
  allDay: boolean;
  /** Written without TZID or Z: phones read it in each guest's own zone. */
  floating: boolean;
  name: string;
  location?: string;
  uid?: string;
}

export interface Expansion {
  /** Occurrences from the start of the venue's today to EXPAND_DAYS ahead, sorted by start. */
  occurrences: Occurrence[];
  /** VEVENTs in the file. */
  events: number;
  /** One-off events outside the window, left out. */
  outsideWindow: number;
  /** Events the reader could not expand, with the rule or reason quoted. Could-not-check, never a guess. */
  unsupported: { summary: string; reason: string }[];
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

interface Rule {
  freq: "WEEKLY" | "MONTHLY";
  interval: number;
  count?: number;
  until?: number;
  /** Weekdays, 0 = Sunday, with an optional ordinal for MONTHLY ("2TH", "-1FR"). */
  byday: { day: number; nth?: number }[];
}

const SUPPORTED_KEYS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYSETPOS", "WKST"]);

/** WEEKLY and MONTHLY with BYDAY (and BYSETPOS for MONTHLY) only; anything else is undefined. */
export function parseRule(rrule: string, until: (t: IcsTime) => number | undefined): Rule | string {
  const parts = new Map<string, string>();
  for (const p of rrule.split(";")) {
    const eq = p.indexOf("=");
    if (eq > 0) parts.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "WEEKLY" && freq !== "MONTHLY") return `FREQ=${freq ?? "?"} is not read`;
  for (const k of parts.keys()) if (!SUPPORTED_KEYS.has(k)) return `${k} is not read`;
  const byday: Rule["byday"] = [];
  for (const d of (parts.get("BYDAY") ?? "").split(",").filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
    if (!m) return `BYDAY=${d} is not read`;
    if (m[1] && freq === "WEEKLY") return `BYDAY=${d} with an ordinal is not read for WEEKLY`;
    byday.push({
      day: WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]),
      ...(m[1] ? { nth: Number(m[1]) } : {}),
    });
  }
  const setpos = parts.get("BYSETPOS");
  if (setpos !== undefined) {
    if (freq !== "MONTHLY" || !/^-?\d+$/.test(setpos) || byday.some((b) => b.nth !== undefined))
      return `BYSETPOS=${setpos} is not read here`;
    for (const b of byday) b.nth = Number(setpos);
  }
  const rule: Rule = {
    freq,
    interval: Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1),
    byday,
  };
  const count = parts.get("COUNT");
  if (count !== undefined) rule.count = Number(count);
  const u = parts.get("UNTIL");
  if (u !== undefined) {
    const ms = until({ ...untilTime(u) });
    if (ms === undefined) return `UNTIL=${u} is not read`;
    rule.until = ms;
  }
  return rule;
}

function untilTime(v: string): IcsTime {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v) ?? [];
  return {
    kind: m[4] === undefined ? "date" : m[7] ? "utc" : "floating",
    raw: v,
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] === undefined ? 23 : Number(m[4]),
    minute: m[5] === undefined ? 59 : Number(m[5]),
    second: m[6] === undefined ? 59 : Number(m[6]),
  };
}

/** Days since 1970-01-01 for a calendar date (no zone involved). */
function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}
function fromDayNumber(n: number): { year: number; month: number; day: number; weekday: number } {
  const dt = new Date(n * DAY);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
    weekday: dt.getUTCDay(),
  };
}

/** The calendar dates a rule produces, from the event's first date, in order, bounded. */
function ruleDates(first: IcsTime, rule: Rule, lastDay: number): number[] {
  const start = dayNumber(first.year, first.month, first.day);
  const out: number[] = [];
  const firstWeekday = fromDayNumber(start).weekday;
  const days = rule.byday.length > 0 ? rule.byday : [{ day: firstWeekday }];
  const cap = () => rule.count === undefined || out.length < rule.count;
  if (rule.freq === "WEEKLY") {
    const weekStart = start - firstWeekday;
    for (let d = start; d <= lastDay && cap(); d++) {
      const week = Math.floor((d - weekStart) / 7);
      if (week % rule.interval !== 0) continue;
      if (days.some((b) => b.day === fromDayNumber(d).weekday)) out.push(d);
    }
    return out;
  }
  // MONTHLY: each nth weekday of every interval-th month, or every such weekday when no ordinal.
  for (let i = 0; cap(); i += rule.interval) {
    const y = first.year + Math.floor((first.month - 1 + i) / 12);
    const m = ((first.month - 1 + i) % 12) + 1;
    const monthStart = dayNumber(y, m, 1);
    if (monthStart > lastDay) break;
    const monthDays = dayNumber(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - monthStart;
    const picks: number[] = [];
    for (const b of days) {
      const matches: number[] = [];
      for (let d = 0; d < monthDays; d++)
        if (fromDayNumber(monthStart + d).weekday === b.day) matches.push(monthStart + d);
      if (b.nth === undefined) picks.push(...matches);
      else {
        const pick = b.nth > 0 ? matches[b.nth - 1] : matches[matches.length + b.nth];
        if (pick !== undefined) picks.push(pick);
      }
    }
    for (const d of picks.sort((a, c) => a - c))
      if (d >= start && d <= lastDay && cap()) out.push(d);
  }
  return out;
}

/**
 * Expand a calendar for the window [start of the venue's today, now + EXPAND_DAYS] into a sorted
 * array. Recurrences are generated as wall times in the event's own zone and converted with Intl, so
 * an event at 9 PM every Thursday stays 9 PM local across a daylight-saving change.
 */
export function expandCalendar(file: IcsFile, now: number, venueZone: string): Expansion {
  const today = localDate(now, venueZone).split("-").map(Number) as [number, number, number];
  const windowStart = zonedToUtc(
    { year: today[0], month: today[1], day: today[2], hour: 0, minute: 0 },
    venueZone,
  );
  const windowEnd = now + EXPAND_DAYS * DAY;
  const result: Expansion = {
    occurrences: [],
    events: file.events.length,
    outsideWindow: 0,
    unsupported: [],
  };

  for (const ev of file.events) {
    const s = ev.start;
    if (!s) {
      result.unsupported.push({ summary: ev.summary, reason: "no DTSTART" });
      continue;
    }
    const zone = s.kind === "utc" ? "UTC" : s.kind === "zoned" ? (s.tzid ?? venueZone) : venueZone;
    if (!isTimeZone(zone)) {
      result.unsupported.push({
        summary: ev.summary,
        reason: `TZID=${zone} is not a known time zone`,
      });
      continue;
    }
    const at = (t: IcsTime) =>
      zonedToUtc(t, t.kind === "utc" ? "UTC" : t.kind === "zoned" ? (t.tzid ?? zone) : zone);
    const startMs = at(s);
    const duration = ev.end ? at(ev.end) - startMs : s.kind === "date" ? DAY : 0;
    const make = (dayNum: number): Occurrence => {
      const d = fromDayNumber(dayNum);
      const ms = zonedToUtc({ ...d, hour: s.hour, minute: s.minute, second: s.second }, zone);
      const date =
        s.kind === "date"
          ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
          : localDate(ms, s.kind === "utc" ? venueZone : zone);
      return {
        start: ms,
        ...(duration > 0 ? { end: ms + duration } : {}),
        date,
        allDay: s.kind === "date",
        floating: s.kind === "floating",
        name: ev.summary,
        ...(ev.location ? { location: ev.location } : {}),
        ...(ev.uid ? { uid: ev.uid } : {}),
      };
    };
    const inWindow = (o: Occurrence) => (o.end ?? o.start) >= windowStart && o.start <= windowEnd;
    if (!ev.rrule) {
      const o = make(dayNumber(s.year, s.month, s.day));
      if (inWindow(o)) result.occurrences.push(o);
      else result.outsideWindow++;
      continue;
    }
    const rule = parseRule(ev.rrule, (t) => zonedToUtc(t, t.kind === "utc" ? "UTC" : zone));
    if (typeof rule === "string") {
      result.unsupported.push({ summary: ev.summary, reason: `RRULE:${ev.rrule} (${rule})` });
      continue;
    }
    const lastDay = Math.floor(windowEnd / DAY) + 1;
    for (const d of ruleDates(s, rule, lastDay)) {
      const o = make(d);
      if (rule.until !== undefined && o.start > rule.until) break;
      if (inWindow(o)) result.occurrences.push(o);
    }
  }
  result.occurrences.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  return result;
}

/** Occurrences that start on a local date, in start order. */
export function onDate(occurrences: readonly Occurrence[], date: string): Occurrence[] {
  return occurrences.filter((o) => o.date === date);
}

/** The first occurrence starting at or after an instant (binary search on the sorted array). */
export function nextAfter(occurrences: readonly Occurrence[], ms: number): Occurrence | undefined {
  let lo = 0;
  let hi = occurrences.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((occurrences[mid]?.start ?? 0) < ms) lo = mid + 1;
    else hi = mid;
  }
  return occurrences[lo];
}

export { wallTimeAt };
