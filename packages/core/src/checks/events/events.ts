import type { CalendarRead } from "../../calendars.js";
import { addressParts } from "../../facts/business.js";
import { isTimeZone, localDate, localTime, zonedToUtc } from "../../ics/time.js";
import type { CheckContext } from "../../model.js";
import { jsonLdNodes, type PageSnapshot } from "../../snapshot.js";

/** An Event in JSON-LD, the fields the events checks read. */
export interface EventFacts {
  name: string;
  startRaw?: string;
  endRaw?: string;
  status?: string;
  location?: {
    name?: string;
    id?: string;
    addressText?: string;
    streetNumber?: string;
    zip?: string;
  };
  hasLocation: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function isEventType(t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && /(?:^|[/:])\w*Event$/.test(x.trim()));
}

/** Every Event node (Event and its subtypes: MusicEvent, FoodEvent, SocialEvent and so on). */
export function pageEvents(page: Pick<PageSnapshot, "jsonLd">): EventFacts[] {
  return jsonLdNodes(page)
    .filter((n) => isEventType(n["@type"]))
    .map((n) => {
      const loc = n.location;
      const facts: EventFacts = {
        name: str(n.name) ?? "(unnamed event)",
        hasLocation: loc !== undefined && loc !== null && loc !== "",
      };
      const start = str(n.startDate);
      const end = str(n.endDate);
      const status = str(n.eventStatus);
      if (start) facts.startRaw = start;
      if (end) facts.endRaw = end;
      if (status) facts.status = status;
      if (loc && typeof loc === "object" && !Array.isArray(loc)) {
        const l = loc as Record<string, unknown>;
        const address = l.address;
        let addressText: string | undefined;
        if (typeof address === "string") addressText = address;
        else if (address && typeof address === "object") {
          const a = address as Record<string, unknown>;
          addressText = [str(a.streetAddress), str(a.addressLocality), str(a.postalCode)]
            .filter(Boolean)
            .join(", ");
        }
        facts.location = {
          ...(str(l.name) ? { name: str(l.name) } : {}),
          ...(str(l["@id"]) ? { id: str(l["@id"]) } : {}),
          ...(addressText ? { addressText, ...addressParts(addressText) } : {}),
        };
      } else if (typeof loc === "string") facts.location = { name: loc };
      return facts;
    });
}

/** An event date: a full date-time (with or without an offset) or a date alone. */
export interface EventTime {
  ms: number;
  /** Local date in the venue's zone. */
  date: string;
  allDay: boolean;
}

/**
 * Read a schema.org date-time in the venue's zone. "2026-11-12T19:00-08:00" is an instant;
 * "2026-11-12T19:00" (no offset) is wall time in the venue's zone; "2026-11-12" is a date, not midnight.
 */
export function eventTime(raw: string, zone: string): EventTime | undefined {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      raw.trim(),
    );
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) {
    return {
      ms: zonedToUtc({ year: y, month: mo, day: d, hour: 0, minute: 0 }, zone),
      date: `${m[1]}-${m[2]}-${m[3]}`,
      allDay: true,
    };
  }
  const wall = {
    year: y,
    month: mo,
    day: d,
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] ?? 0),
  };
  const ms = m[7] ? Date.parse(raw.trim()) : zonedToUtc(wall, zone);
  if (Number.isNaN(ms)) return undefined;
  return { ms, date: localDate(ms, zone), allDay: false };
}

export { localTime };

/**
 * The venue's time zone: the configured one, else the calendar's X-WR-TIMEZONE, else the first TZID
 * a calendar event uses. Never the machine's zone. Undefined when nothing names one.
 */
export function venueZone(
  ctx: CheckContext,
  calendars: readonly CalendarRead[] = [],
): string | undefined {
  const configured = ctx.expect?.timeZone;
  if (configured && isTimeZone(configured)) return configured;
  for (const c of calendars) {
    if (c.state !== "found") continue;
    if (c.file.calendarZone && isTimeZone(c.file.calendarZone)) return c.file.calendarZone;
    const tz = c.file.events.find((e) => e.start?.kind === "zoned")?.start?.tzid;
    if (tz && isTimeZone(tz)) return tz;
  }
  return undefined;
}

/** "trivia night!" and "Trivia Night" are one name. */
export function eventName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
