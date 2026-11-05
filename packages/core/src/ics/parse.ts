/**
 * A narrow RFC 5545 reader: unfolds lines, reads VEVENT and VTIMEZONE, and keeps the properties
 * Gaugeline checks (SUMMARY, LOCATION, UID, DTSTART, DTEND, RRULE). Anything it does not read is
 * ignored; it never throws on an odd file.
 */

/** A DTSTART or DTEND as written. */
export interface IcsTime {
  /** utc: ends in Z. zoned: has TZID. floating: neither (read in each guest's own zone). date: VALUE=DATE. */
  kind: "utc" | "zoned" | "floating" | "date";
  raw: string;
  tzid?: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface IcsEvent {
  uid?: string;
  summary: string;
  location?: string;
  start?: IcsTime;
  end?: IcsTime;
  rrule?: string;
  /** The 1-based line of BEGIN:VEVENT, after unfolding. */
  line: number;
}

export interface IcsFile {
  events: IcsEvent[];
  /** TZIDs defined by VTIMEZONE components. */
  timezones: Set<string>;
  /** X-WR-TIMEZONE, the calendar's declared zone, when present. */
  calendarZone?: string;
}

/** RFC 5545 §3.1: a line starting with a space or tab continues the previous one. */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else out.push(line);
  }
  return out;
}

/** RFC 5545 §3.3.11 TEXT: \\, \; \, and \n. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** "DTSTART;TZID=America/Los_Angeles:20261105T210000" -> name, params, value. Quoted params kept whole. */
export function contentLine(
  line: string,
): { name: string; params: Record<string, string>; value: string } | undefined {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i >= line.length) return undefined;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name = "", ...rest] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

export function parseIcsTime(value: string, params: Record<string, string>): IcsTime | undefined {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || params.VALUE?.toUpperCase() === "DATE") {
    const d = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!d) return undefined;
    return {
      kind: "date",
      raw: v,
      year: +d[1]!,
      month: +d[2]!,
      day: +d[3]!,
      hour: 0,
      minute: 0,
      second: 0,
    };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(v);
  if (!m) return undefined;
  const base = {
    raw: v,
    year: +m[1]!,
    month: +m[2]!,
    day: +m[3]!,
    hour: +m[4]!,
    minute: +m[5]!,
    second: +m[6]!,
  };
  if (m[7]) return { kind: "utc", ...base };
  if (params.TZID) return { kind: "zoned", tzid: params.TZID, ...base };
  return { kind: "floating", ...base };
}

export function parseIcs(text: string): IcsFile {
  const file: IcsFile = { events: [], timezones: new Set() };
  const stack: string[] = [];
  let event: IcsEvent | undefined;
  unfold(text).forEach((line, index) => {
    const cl = contentLine(line);
    if (!cl) return;
    if (cl.name === "BEGIN") {
      const what = cl.value.trim().toUpperCase();
      stack.push(what);
      if (what === "VEVENT") event = { summary: "", line: index + 1 };
      return;
    }
    if (cl.name === "END") {
      const what = stack.pop();
      if (what === "VEVENT" && event) {
        file.events.push(event);
        event = undefined;
      }
      return;
    }
    const inside = stack.at(-1);
    if (inside === "VTIMEZONE" && cl.name === "TZID") file.timezones.add(cl.value.trim());
    if (inside === "VCALENDAR" && cl.name === "X-WR-TIMEZONE") file.calendarZone = cl.value.trim();
    if (inside !== "VEVENT" || !event) return;
    switch (cl.name) {
      case "SUMMARY":
        event.summary = unescapeText(cl.value).trim();
        break;
      case "LOCATION":
        event.location = unescapeText(cl.value).trim();
        break;
      case "UID":
        event.uid = cl.value.trim();
        break;
      case "DTSTART": {
        const t = parseIcsTime(cl.value, cl.params);
        if (t) event.start = t;
        break;
      }
      case "DTEND": {
        const t = parseIcsTime(cl.value, cl.params);
        if (t) event.end = t;
        break;
      }
      case "RRULE":
        event.rrule = cl.value.trim();
        break;
    }
  });
  return file;
}
