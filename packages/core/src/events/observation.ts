import { load } from "cheerio/slim";
import { sanitise } from "../untrusted.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  EVENT_WAIT_MS,
  eventsOf,
  judgeClick,
  type ClickTarget,
  type ClickVerdict,
  type EventsRead,
  type ObservedClick,
} from "./observe.js";
import type { EventRule, EventsConfig } from "./types.js";

/**
 * What a click observer needs from core, as plain rules: which of the plan's elements may be clicked, how a
 * request the page tried to make is read as an event, and how the phone and the keyboard are judged against
 * the desktop and the page. Nothing here touches a browser or the network: the same input gives the same
 * answer, and a renderer's observer only supplies the observation.
 */

export { eventsOf };

/** CSS pixels. The phone is a small one; the desktop is a laptop. */
export const PHONE_VIEWPORT = Object.freeze({ width: 375, height: 667 });
export const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** Presses of the Tab key, at most, to read the focus order. */
export const MAX_TAB_STOPS = 200;

export interface SkippedTarget {
  path: string;
  text: string;
  reason: string;
}

/**
 * Of the plan's elements, the ones an observer may click, and why it leaves out the rest. Links only: an
 * element with an address that is a web address, and not inside a form (a button, an input, a menu button
 * and a link in a form are never clicked: rule 14, ADR-0009 "links only"). A link to another site is clicked
 * only when the plan names it by a selector; a region of the page the plan reads (every link in the nav) is
 * not a list of other sites to visit.
 */
export function selectClickable(
  targets: readonly ClickTarget[],
  config: EventsConfig,
  page: PageSnapshot,
): { click: ClickTarget[]; skipped: SkippedTarget[] } {
  const $ = load((page.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, ""));
  const own = new URL(page.finalUrl).origin;
  const click: ClickTarget[] = [];
  const skipped: SkippedTarget[] = [];
  const leave = (t: ClickTarget, reason: string) =>
    skipped.push({ path: t.path, text: t.text, reason });
  for (const t of targets) {
    if (t.destination === undefined) {
      leave(t, "it is not a link (it has no address), and only links are clicked");
      continue;
    }
    let url: URL;
    try {
      url = new URL(t.destination);
    } catch {
      leave(t, "its address is not a web address");
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      leave(t, "its address is not a web address (only http and https links are clicked)");
      continue;
    }
    let inForm = false;
    try {
      inForm = $(t.path).closest("form").length > 0;
    } catch {
      inForm = false;
    }
    if (inForm) {
      leave(t, "it is inside a form, and nothing in a form is clicked");
      continue;
    }
    const named = config.events[t.rule]?.selector !== undefined;
    if (url.origin !== own && !named) {
      leave(
        t,
        "it goes to another site and the plan lists it only as part of a region, not by selector",
      );
      continue;
    }
    click.push(named && url.origin !== own ? { ...t, allowCrossSite: true } : t);
  }
  return { click, skipped };
}

export interface ParityRow {
  target: ClickTarget;
  desktop: ClickVerdict;
  phone: ClickVerdict;
  /** What differs, one plain sentence each, in a fixed order. Bounded: the page's words are cleaned and cut. */
  differences: string[];
}

export interface ParityReport {
  rows: ParityRow[];
  /** Links not read at both widths, so neither compared nor passed: the reason, in a sentence. */
  notCompared: { target: ClickTarget; reason: string }[];
}

const D = DESKTOP_VIEWPORT.width;
const P = PHONE_VIEWPORT.width;
/** A name or a value from the page, for a sentence: cleaned and cut short. */
const snippet = (value: string): string => sanitise(value, 40).text;

/** What one width did for one plan line: the event it was meant to send, and the other names it sent. */
interface WidthReading {
  /** The planned event within the wait, as sent (the first, when there are several). */
  first?: Record<string, unknown>;
  count: number;
  /** When the planned event came after the wait, and nothing came in time. */
  lateMs?: number;
  /** Other event names sent within the wait (the tag manager's own `gtm.*` are not the site's). */
  others: string[];
}

function readWidth(rule: Pick<EventRule, "event">, click: ObservedClick): WidthReading {
  const all = eventsOf(click);
  const named = all.filter((e) => e.data.event === rule.event);
  const inTime = named.filter((e) => e.atMs <= EVENT_WAIT_MS);
  const late = named.find((e) => e.atMs > EVENT_WAIT_MS);
  const others = [
    ...new Set(
      all
        .filter((e) => e.atMs <= EVENT_WAIT_MS)
        .map((e) => e.data.event)
        .filter(
          (n): n is string =>
            typeof n === "string" && n !== "" && n !== rule.event && !/^gtm\./.test(n),
        ),
    ),
  ].sort();
  const first = inTime[0];
  return {
    ...(first ? { first: first.data } : {}),
    count: inTime.length,
    ...(late && !first ? { lateMs: late.atMs } : {}),
    others,
  };
}

type ValueKind = "empty" | "text" | "a number" | "true or false";
const kindOf = (v: unknown): ValueKind => {
  if (typeof v === "string") return v.trim() === "" ? "empty" : "text";
  if (typeof v === "number") return "a number";
  if (typeof v === "boolean") return "true or false";
  return "empty";
};
const MAX_DIFFERENCES = 6;

/**
 * Where one link's phone read differs from its desktop read. Plain comparisons, in a fixed order: the planned
 * event on one width and not the other (or another name, or late, or twice), then each parameter the plan lists
 * (filled on one width and empty on the other, or a different kind of value), then the parameters the plan
 * does not list that only one width sends. Values are compared by kind and never by exact text: a parameter
 * such as a device name differs between a phone and a desktop on purpose, and a plan can say nothing about that.
 */
function widthDifferences(
  rule: Pick<EventRule, "event" | "params">,
  desktop: ObservedClick,
  phone: ObservedClick,
): string[] {
  const d = readWidth(rule, desktop);
  const p = readWidth(rule, phone);
  const out: string[] = [];
  const ev = snippet(rule.event);
  const onlyOn = (w: number, other: number, o: WidthReading): string => {
    if (o.lateMs !== undefined)
      return `sent ${ev} within ${EVENT_WAIT_MS} ms at ${w} px but after ${o.lateMs} ms at ${other} px`;
    const instead = o.others[0];
    return instead !== undefined
      ? `sent ${ev} at ${w} px but ${snippet(instead)} at ${other} px`
      : `sent ${ev} at ${w} px and nothing at ${other} px`;
  };
  if (d.first && !p.first) {
    out.push(onlyOn(D, P, p));
    return out;
  }
  if (!d.first && p.first) {
    out.push(onlyOn(P, D, d));
    return out;
  }
  if (!d.first || !p.first) return out;
  if (d.count !== p.count)
    out.push(
      d.count > p.count
        ? `sent ${ev} ${d.count} times at ${D} px and ${p.count} time${p.count === 1 ? "" : "s"} at ${P} px`
        : `sent ${ev} ${p.count} times at ${P} px and ${d.count} time${d.count === 1 ? "" : "s"} at ${D} px`,
    );
  for (const param of rule.params) {
    const dk = kindOf(d.first[param]);
    const pk = kindOf(p.first[param]);
    if (dk === pk) continue;
    const name = snippet(param);
    if (dk === "empty") out.push(`${name} is empty at ${D} px and filled at ${P} px`);
    else if (pk === "empty") out.push(`${name} is filled at ${D} px and empty at ${P} px`);
    else out.push(`${name} is ${dk} at ${D} px and ${pk} at ${P} px`);
  }
  const extra = (o: Record<string, unknown>) =>
    new Set(Object.keys(o).filter((k) => k !== "event" && !rule.params.includes(k)));
  const de = extra(d.first);
  const pe = extra(p.first);
  for (const k of [...de].filter((k) => !pe.has(k)).sort())
    out.push(`${snippet(k)} is sent at ${D} px and not at ${P} px`);
  for (const k of [...pe].filter((k) => !de.has(k)).sort())
    out.push(`${snippet(k)} is sent at ${P} px and not at ${D} px`);
  return out;
}

/**
 * The links that answer differently on a phone than on a desktop. A link that could not be observed on both
 * widths is not compared, and is listed as such: it is neither a difference nor a pass. A link silent on both
 * is events-fire's. Without a phone read there is nothing to compare, and the report is empty.
 */
export function judgeParity(read: EventsRead): ParityReport {
  const none: ParityReport = { rows: [], notCompared: [] };
  if ("unchecked" in read.result || read.result.phone === undefined) return none;
  const phone = new Map(read.result.phone.map((c) => [c.path, c]));
  const desktop = new Map(read.result.clicks.map((c) => [c.path, c]));
  const report: ParityReport = { rows: [], notCompared: [] };
  for (const target of read.targets) {
    const rule = read.config.events[target.rule];
    if (!rule) continue;
    const d = desktop.get(target.path);
    const p = phone.get(target.path);
    const why = (width: number, c: ObservedClick | undefined): string | undefined =>
      c === undefined
        ? `at ${width} px: it was not read`
        : c.unobserved !== undefined
          ? `at ${width} px: ${c.unobserved}`
          : undefined;
    const reason = why(D, d) ?? why(P, p);
    if (reason !== undefined || !d || !p) {
      report.notCompared.push({ target, reason: reason ?? "it was not read" });
      continue;
    }
    const differences = widthDifferences(rule, d, p);
    if (differences.length > 0)
      report.rows.push({
        target,
        desktop: judgeClick(rule, d),
        phone: judgeClick(rule, p),
        differences:
          differences.length > MAX_DIFFERENCES
            ? [
                ...differences.slice(0, MAX_DIFFERENCES),
                `and ${differences.length - MAX_DIFFERENCES} more`,
              ]
            : differences,
      });
  }
  return report;
}

export interface FocusReport {
  /** Links the Tab key never reached. */
  unreachable: ClickTarget[];
  /**
   * Links that took focus in a different place than they come in the page, positions counted among the listed
   * links the keyboard reached. Only the links that moved: not every link they moved past.
   */
  outOfOrder: { target: ClickTarget; documentIndex: number; focusIndex: number }[];
  /** Links that could not be watched at the desktop width: neither reached nor missed, never a pass. */
  notRead: { target: ClickTarget; reason: string }[];
}

/** The position of each target's element in the page's HTML (a stable order); a path that finds nothing goes last. */
function documentOrder(targets: readonly ClickTarget[], page: PageSnapshot): Map<string, number> {
  const $ = load((page.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, ""));
  const nodes = $("*").toArray();
  const at = new Map<string, number>();
  targets.forEach((t, i) => {
    let found: number = -1;
    try {
      const el = $(t.path).get(0);
      found = el ? nodes.indexOf(el) : -1;
    } catch {
      found = -1;
    }
    at.set(t.path, found >= 0 ? found : nodes.length + i);
  });
  return at;
}

/** Which of these positions stay where they are: the longest run that already goes up (the first, on a tie). */
function stays(positions: readonly number[]): boolean[] {
  const length = positions.map(() => 1);
  const before = positions.map(() => -1);
  positions.forEach((p, i) => {
    for (let j = 0; j < i; j++) {
      const q = positions[j] as number;
      if (q < p && (length[j] as number) + 1 > (length[i] as number)) {
        length[i] = (length[j] as number) + 1;
        before[i] = j;
      }
    }
  });
  let best = 0;
  length.forEach((l, i) => {
    if (l > (length[best] as number)) best = i;
  });
  const keep = positions.map(() => false);
  for (let i = best; i >= 0 && positions.length > 0; i = before[i] as number) keep[i] = true;
  return keep;
}

/**
 * The listed links against the order the keyboard reached them in. The order to expect is the order the links
 * come in the page's HTML (`page`), or the order of the plan's lines when no page is given; the plan has no
 * order of its own, and a layout that moves a link on the screen is not read. Empty when focus was not read.
 */
export function judgeFocusOrder(read: EventsRead, page?: PageSnapshot): FocusReport {
  const none: FocusReport = { unreachable: [], outOfOrder: [], notRead: [] };
  if ("unchecked" in read.result || read.result.focusOrder === undefined) return none;
  const focus = read.result.focusOrder;
  // A link that could not be clicked (hidden at this width, say) cannot be expected to take focus either.
  const unobserved = new Map(
    read.result.clicks.filter((c) => c.unobserved !== undefined).map((c) => [c.path, c.unobserved]),
  );
  const all = read.targets.filter((t) => t.destination !== undefined);
  const notRead = all.flatMap((target) => {
    const reason = unobserved.get(target.path);
    return reason === undefined ? [] : [{ target, reason }];
  });
  const links = all.filter((t) => !unobserved.has(t.path));
  const order = page ? documentOrder(links, page) : undefined;
  const inPage = order
    ? [...links].sort((a, b) => (order.get(a.path) as number) - (order.get(b.path) as number))
    : links;
  const reached = inPage.filter((t) => focus.includes(t.path));
  const keep = stays(reached.map((t) => focus.indexOf(t.path)));
  const byFocus = [...reached].sort((a, b) => focus.indexOf(a.path) - focus.indexOf(b.path));
  return {
    unreachable: inPage.filter((t) => !focus.includes(t.path)),
    outOfOrder: reached.flatMap((target, documentIndex) =>
      keep[documentIndex] ? [] : [{ target, documentIndex, focusIndex: byFocus.indexOf(target) }],
    ),
    notRead,
  };
}

/**
 * The `tabindex` each plan element carries in the HTML the run fetched, as a whole number, for the elements
 * that have a value. Read as the HTML standard reads an integer: leading spaces, an optional sign, then the
 * digits, and anything after them ignored; a value that is not one is left out. A tabindex a script adds later
 * is not seen here (a link that moves for it shows in judgeFocusOrder).
 */
export function tabindexes(
  read: Pick<EventsRead, "targets">,
  page: PageSnapshot,
): Map<string, number> {
  const $ = load((page.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, ""));
  const out = new Map<string, number>();
  for (const target of read.targets) {
    let raw: string | undefined;
    try {
      raw = $(target.path).first().attr("tabindex");
    } catch {
      raw = undefined;
    }
    const m = raw === undefined ? null : /^\s*([+-]?\d+)/.exec(raw);
    if (m) out.set(target.path, Number.parseInt(m[1] as string, 10));
  }
  return out;
}

/**
 * The plan's elements that carry a positive `tabindex`: a positive value moves the element ahead of every
 * element without one, whatever the page's order. Read from the HTML as sent, so it needs no browser.
 */
export function positiveTabindex(
  read: Pick<EventsRead, "targets">,
  page: PageSnapshot,
): { target: ClickTarget; value: number }[] {
  const at = tabindexes(read, page);
  return read.targets.flatMap((target) => {
    const value = at.get(target.path) ?? 0;
    return value > 0 ? [{ target, value }] : [];
  });
}

const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_PARAMS = 20;
/** At most this many events are read from one request, this much of its body and this much of an address. */
export const MAX_EVENTS_PER_REQUEST = 10;
export const MAX_REQUEST_BODY_CHARS = 64 * 1024;
const MAX_LINE_CHARS = 16 * 1024;
/** A value is cut before it is cleaned, so a megabyte of text is never walked. */
const MAX_VALUE_READ = 500;
const text = (value: string): string => sanitise(value.slice(0, MAX_VALUE_READ), 120).text;

interface ParsedEvent {
  host: string;
  name: string;
  params: Record<string, string>;
}

/** The parameters of one event line: stops reading at MAX_PARAMS, so a line of a million costs the same as twenty. */
function fromPairs(
  host: string,
  line: string,
  nameKey: string,
  keys: (k: string) => string | undefined,
): ParsedEvent[] {
  const pairs = new URLSearchParams(line.slice(0, MAX_LINE_CHARS));
  const name = pairs.get(nameKey);
  if (name === null || name === "") return [];
  const params: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of pairs) {
    const key = keys(k);
    if (key === undefined || !NAME.test(key)) continue;
    params[key] = text(v);
    if (++count >= MAX_PARAMS) break;
  }
  return [{ host, name: text(name), params }];
}

/**
 * The event a request to an analytics host would have carried, read from the address and the body the page
 * made it with: Google Analytics 4 (`en`, `ep.` and `epn.` parameters, one event a line in a body), Meta's
 * pixel (`ev`, `cd[...]`), and a JSON body with an `event` (Segment and the like). Only the event name and
 * its parameters are read: an identifier, a client id or a page address in the request is never kept. What
 * the page wrote is cleaned and cut. A request this does not recognise gives no event. The request is the
 * page's, so it is bounded: at most MAX_EVENTS_PER_REQUEST events, MAX_REQUEST_BODY_CHARS of body, 20
 * parameters an event, and a value cut at 120 characters.
 */
export function parseAnalyticsRequest(rawUrl: string, body: string | undefined): ParsedEvent[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase();
  const read = body?.slice(0, MAX_REQUEST_BODY_CHARS);
  if (url.pathname.endsWith("/g/collect")) {
    const ga = (k: string) =>
      k.startsWith("ep.") ? k.slice(3) : k.startsWith("epn.") ? k.slice(4) : undefined;
    const out: ParsedEvent[] = [];
    // The body is one event a line; with none, the address is the event. Lines are cut off one at a time.
    let from = 0;
    const source = read !== undefined && read.trim() !== "" ? read : url.search.slice(1);
    while (from <= source.length && out.length < MAX_EVENTS_PER_REQUEST) {
      let to = source.indexOf("\n", from);
      if (to === -1) to = source.length;
      out.push(...fromPairs(host, source.slice(from, to), "en", ga));
      from = to + 1;
    }
    return out.slice(0, MAX_EVENTS_PER_REQUEST);
  }
  if (host.endsWith("facebook.com") && url.pathname.startsWith("/tr")) {
    return fromPairs(host, url.search.slice(1), "ev", (k) =>
      /^cd\[[^\]]+\]$/.test(k) ? k.slice(3, -1) : undefined,
    );
  }
  if (read !== undefined) {
    try {
      const json: unknown = JSON.parse(read);
      if (typeof json === "object" && json !== null && !Array.isArray(json)) {
        const o = json as Record<string, unknown>;
        if (typeof o.event === "string" && o.event !== "") {
          const source =
            typeof o.properties === "object" &&
            o.properties !== null &&
            !Array.isArray(o.properties)
              ? (o.properties as Record<string, unknown>)
              : {};
          const params: Record<string, string> = {};
          let count = 0;
          // for...in with a break: Object.entries would build the whole list of a huge object first.
          for (const k in source) {
            if (!Object.hasOwn(source, k)) continue;
            const v = source[k];
            if (
              NAME.test(k) &&
              (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
            ) {
              params[k] = text(String(v));
              if (++count >= MAX_PARAMS) break;
            }
          }
          return [{ host, name: text(o.event), params }];
        }
      }
    } catch {
      return [];
    }
  }
  return [];
}
