/** Wall-clock time in a named IANA zone, converted with Intl only: never the machine's zone. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when Intl knows the zone. */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall time at an instant in a zone. */
export function wallTimeAt(ms: number, timeZone: string): Required<WallTime> {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

function wallAsUtc(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);
}

/** The zone's offset from UTC at an instant, in milliseconds. */
export function offsetAt(ms: number, timeZone: string): number {
  return wallAsUtc(wallTimeAt(ms, timeZone)) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall time happens in a zone. Two passes settle the offset on either side of a
 * daylight-saving change; a wall time that falls in the spring-forward gap lands an hour later.
 */
export function zonedToUtc(w: WallTime, timeZone: string): number {
  const guess = wallAsUtc(w);
  let ms = guess - offsetAt(guess, timeZone);
  ms = guess - offsetAt(ms, timeZone);
  return ms;
}

/** "2026-11-05" for an instant in a zone. */
export function localDate(ms: number, timeZone: string): string {
  const w = wallTimeAt(ms, timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** "21:00" for an instant in a zone. */
export function localTime(ms: number, timeZone: string): string {
  const w = wallTimeAt(ms, timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}
