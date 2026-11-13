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
    click.push(t);
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
const text = (value: string): string => sanitise(value, 120).text;

interface ParsedEvent {
  host: string;
  name: string;
  params: Record<string, string>;
}

function fromPairs(
  host: string,
  pairs: URLSearchParams,
  name: string | null,
  keys: (k: string) => string | undefined,
): ParsedEvent[] {
  if (name === null || name === "") return [];
  const params: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const key = keys(k);
    if (key === undefined || !NAME.test(key) || Object.keys(params).length >= MAX_PARAMS) continue;
    params[key] = text(v);
  }
  return [{ host, name: text(name), params }];
}

/**
 * The event a request to an analytics host would have carried, read from the address and the body the page
 * made it with: Google Analytics 4 (`en`, `ep.` and `epn.` parameters, one event a line in a body), Meta's
 * pixel (`ev`, `cd[...]`), and a JSON body with an `event` (Segment and the like). Only the event name and
 * its parameters are read: an identifier, a client id or a page address in the request is never kept. What
 * the page wrote is cleaned and cut. A request this does not recognise gives no event.
 */
export function parseAnalyticsRequest(rawUrl: string, body: string | undefined): ParsedEvent[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase();
  if (url.pathname.endsWith("/g/collect")) {
    const ga = (k: string) =>
      k.startsWith("ep.") ? k.slice(3) : k.startsWith("epn.") ? k.slice(4) : undefined;
    const lines =
      body !== undefined && body.trim() !== "" ? body.split("\n") : [url.search.slice(1)];
    return lines.flatMap((line) => {
      const pairs = new URLSearchParams(line);
      return fromPairs(host, pairs, pairs.get("en"), ga);
    });
  }
  if (host.endsWith("facebook.com") && url.pathname.startsWith("/tr")) {
    const pairs = url.searchParams;
    return fromPairs(host, pairs, pairs.get("ev"), (k) =>
      /^cd\[[^\]]+\]$/.test(k) ? k.slice(3, -1) : undefined,
    );
  }
  if (body !== undefined) {
    try {
      const json: unknown = JSON.parse(body);
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
          for (const [k, v] of Object.entries(source)) {
            if (!NAME.test(k) || Object.keys(params).length >= MAX_PARAMS) continue;
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
              params[k] = text(String(v));
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
