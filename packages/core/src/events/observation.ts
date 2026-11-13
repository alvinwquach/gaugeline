import { load } from "cheerio/slim";
import { sanitise } from "../untrusted.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  eventsOf,
  judgeClick,
  type ClickTarget,
  type ClickVerdict,
  type EventsRead,
} from "./observe.js";
import type { EventsConfig } from "./types.js";

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
}

const sameVerdict = (a: ClickVerdict, b: ClickVerdict): boolean => {
  if (a.state !== b.state) return false;
  if (a.state === "ok" && b.state === "ok")
    return JSON.stringify(a.sent) === JSON.stringify(b.sent);
  if (a.state === "missing" && b.state === "missing") return a.params.join() === b.params.join();
  if (a.state === "twice" && b.state === "twice") return a.count === b.count;
  return true;
};

/**
 * The links that answer differently on a phone than on a desktop: reports on one and not the other, or
 * reports other values. A link that could not be observed on either is left out: that is not a difference.
 */
export function judgeParity(read: EventsRead): ParityRow[] {
  if ("unchecked" in read.result || read.result.phone === undefined) return [];
  const phone = new Map(read.result.phone.map((c) => [c.path, c]));
  const desktop = new Map(read.result.clicks.map((c) => [c.path, c]));
  const rows: ParityRow[] = [];
  for (const target of read.targets) {
    const rule = read.config.events[target.rule];
    const d = desktop.get(target.path);
    const p = phone.get(target.path);
    if (!rule || !d || !p) continue;
    const dv = judgeClick(rule, d);
    const pv = judgeClick(rule, p);
    if (dv.state === "unobserved" || pv.state === "unobserved") continue;
    if (!sameVerdict(dv, pv)) rows.push({ target, desktop: dv, phone: pv });
  }
  return rows;
}

export interface FocusReport {
  /** Links the Tab key never reached. */
  unreachable: ClickTarget[];
  /** Links that took focus in a different place than they come in the page. */
  outOfOrder: { target: ClickTarget; documentIndex: number; focusIndex: number }[];
}

/** The listed links against the order the keyboard reached them in. Empty when focus was not read. */
export function judgeFocusOrder(read: EventsRead): FocusReport {
  const none: FocusReport = { unreachable: [], outOfOrder: [] };
  if ("unchecked" in read.result || read.result.focusOrder === undefined) return none;
  const focus = read.result.focusOrder;
  // A link that could not be clicked (hidden at this width, say) cannot be expected to take focus either.
  const unobserved = new Set(
    read.result.clicks.filter((c) => c.unobserved !== undefined).map((c) => c.path),
  );
  const links = read.targets.filter((t) => t.destination !== undefined && !unobserved.has(t.path));
  const reached = links.filter((t) => focus.includes(t.path));
  const byFocus = [...reached].sort((a, b) => focus.indexOf(a.path) - focus.indexOf(b.path));
  return {
    unreachable: links.filter((t) => !focus.includes(t.path)),
    outOfOrder: reached.flatMap((target, documentIndex) => {
      const focusIndex = byFocus.indexOf(target);
      return focusIndex === documentIndex ? [] : [{ target, documentIndex, focusIndex }];
    }),
  };
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
