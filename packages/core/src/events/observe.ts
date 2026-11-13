import { load, type CheerioAPI } from "cheerio/slim";
import { selectClickable } from "./observation.js";
import type { createDomStream } from "htmlparser2";
import type { PageSnapshot } from "../snapshot.js";
import type { EventRule, EventsConfig, Region } from "./types.js";

/**
 * Click events, checked against the tracking plan. Clicking needs a rendered page, which arrives
 * with G39; until then core finds the elements to click, judges what an observer reports, and the
 * run has no observer, so the checks are could-not-check. The observer is the one seam: it clicks
 * each target with analytics requests intercepted (recorded, never delivered) and reports what was
 * pushed to dataLayer.
 */

/** htmlparser2's element node (domhandler's Element), named without depending on domhandler. */
export type DomElement = Parameters<NonNullable<Parameters<typeof createDomStream>[2]>>[0];

/** The most elements one run clicks. Proposed: the spec names no number. */
export const MAX_EVENT_TARGETS = 20;
/** How long after a click a push still counts. Proposed: the spec names no number. */
export const EVENT_WAIT_MS = 1500;

/** One element the plan says must report a click. */
export interface ClickTarget {
  /** A CSS path that finds this element on its page, unique within it. */
  path: string;
  /** Which line of the plan selected it (index into config.events). */
  rule: number;
  text: string;
  /** Where a link goes, resolved; undefined for a button. */
  destination?: string;
  /** The label of the menu item it sits under, for a nested menu. */
  parent?: string;
  /** target="_blank": the observer must keep the page and still see the push. */
  newTab: boolean;
}

/** An analytics request the page tried to make after a click: what it would have sent. It was never delivered. */
export interface SentEvent {
  atMs: number;
  host: string;
  /** The event name the request carried, cleaned and cut. */
  name: string;
  /** The event's parameters as text: names from a closed alphabet, values cleaned and cut. */
  params: Record<string, string>;
}

/** What the observer saw after clicking one target. */
export interface ObservedClick {
  path: string;
  /** Objects pushed to dataLayer after the click, each with ms since the click. */
  pushes: { atMs: number; data: Record<string, unknown> }[];
  /** Analytics requests intercepted and recorded, never delivered (their hosts only). */
  blocked: string[];
  /** What those requests would have sent: the event name and parameters read from the request the page made. */
  sent?: SentEvent[];
  /** Set when the element could not be clicked or watched: the reason, in a sentence. Never a pass. */
  unobserved?: string;
}

/**
 * What the observer returns. `clicks` is at the desktop width. With a phone read, `phone` is the same
 * targets clicked at the phone width. `focusOrder` is the listed links' paths in the order the Tab key
 * moved focus to them (at the desktop width), each once.
 */
export type ObserveResult =
  | { clicks: ObservedClick[]; phone?: ObservedClick[]; focusOrder?: string[] }
  | { unchecked: string };

export interface EventObserver {
  observe(input: {
    page: string;
    targets: readonly ClickTarget[];
    consent?: EventsConfig["consent"];
    waitMs: number;
  }): Promise<ObserveResult>;
}

/** Without a rendered read nothing can be clicked: the reason the checks give. */
export const NO_OBSERVER =
  "clicking elements needs a rendered read of the page, which this version doesn't have (decision record G39)";

function cssPath($: CheerioAPI, el: DomElement): string {
  const parts: string[] = [];
  let node: DomElement | null = el;
  while (node && node.type === "tag" && node.name !== "html") {
    const id = $(node).attr("id");
    if (id && /^[A-Za-z][\w-]*$/.test(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const name: string = node.name;
    const parent: DomElement | null = node.parent?.type === "tag" ? node.parent : null;
    const same = parent ? $(parent).children(name).toArray() : [node];
    parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(node) + 1})` : name);
    node = parent;
  }
  return parts.join(" > ");
}

export function regionOf($: CheerioAPI, el: DomElement): Region {
  if ($(el).closest("nav").length > 0) return "nav";
  if ($(el).closest("header").length > 0) return "header";
  if ($(el).closest("footer").length > 0) return "footer";
  return "main";
}

function label($: CheerioAPI, el: DomElement): string {
  const node = $(el);
  return (node.attr("aria-label") ?? node.text()).replace(/\s+/g, " ").trim();
}

/** The menu item a nested link sits under: the first link, button or label of the outer li. */
function parentLabel($: CheerioAPI, el: DomElement): string | undefined {
  const outer = $(el).closest("li").parent().closest("li");
  if (outer.length === 0) return undefined;
  const head = outer.children("a, button, span, summary, details > summary").first();
  const text = head.length > 0 ? label($, head.get(0) as DomElement) : "";
  return text === "" ? undefined : text;
}

/** The elements each line of the plan selects on the page, in document order, at most 20. */
export function clickTargets(page: PageSnapshot, config: EventsConfig): ClickTarget[] {
  const $ = load((page.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, ""));
  const out: ClickTarget[] = [];
  const seen = new Set<string>();
  config.events.forEach((rule: EventRule, i) => {
    let found: DomElement[];
    try {
      found = rule.selector
        ? ($(rule.selector).toArray() as DomElement[])
        : ($("a[href]").toArray() as DomElement[]).filter((el) => regionOf($, el) === rule.region);
    } catch {
      found = [];
    }
    for (const el of found) {
      const path = cssPath($, el);
      if (seen.has(path)) continue;
      seen.add(path);
      const href = $(el).attr("href");
      let destination: string | undefined;
      try {
        destination = href ? new URL(href.trim(), page.finalUrl).href : undefined;
      } catch {
        destination = undefined;
      }
      const parent = parentLabel($, el);
      out.push({
        path,
        rule: i,
        text: label($, el),
        ...(destination ? { destination } : {}),
        ...(parent ? { parent } : {}),
        newTab: $(el).attr("target") === "_blank",
      });
    }
  });
  return out.slice(0, MAX_EVENT_TARGETS);
}

/**
 * Everything a click sent, as the objects a dataLayer push would be: the pushes, then each analytics
 * request the page tried to make whose event name no push already carried (a page that does both for one
 * event is one event, not two).
 */
export function eventsOf(click: ObservedClick): { atMs: number; data: Record<string, unknown> }[] {
  const named = new Set(click.pushes.map((p) => p.data.event));
  const fromRequests = (click.sent ?? [])
    .filter((s) => !named.has(s.name))
    .map((s) => ({ atMs: s.atMs, data: { event: s.name, ...s.params } }));
  return [...click.pushes, ...fromRequests];
}

/** A parameter counts as filled when it is a non-empty string, a number or a boolean. */
function filled(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  return typeof v === "number" || typeof v === "boolean";
}

export type ClickVerdict =
  | { state: "unobserved"; reason: string }
  | { state: "ok"; sent: Record<string, unknown> }
  | { state: "silent"; lateMs?: number }
  | { state: "twice"; count: number; sent: Record<string, unknown> }
  | { state: "missing"; params: string[]; sent: Record<string, unknown> };

/**
 * Expected against observed: the event fired once within the wait, with every required
 * parameter filled. A push after the wait is reported as late, not counted.
 */
export function judgeClick(
  rule: Pick<EventRule, "event" | "params">,
  click: ObservedClick | undefined,
  waitMs = EVENT_WAIT_MS,
): ClickVerdict {
  if (click?.unobserved !== undefined) return { state: "unobserved", reason: click.unobserved };
  const named = (click ? eventsOf(click) : []).filter((p) => p.data.event === rule.event);
  const inTime = named.filter((p) => p.atMs <= waitMs);
  const first = inTime[0];
  if (!first) {
    const late = named[0]?.atMs;
    return late === undefined ? { state: "silent" } : { state: "silent", lateMs: late };
  }
  if (inTime.length > 1) return { state: "twice", count: inTime.length, sent: first.data };
  const missing = rule.params.filter((p) => !filled(first.data[p]));
  return missing.length > 0
    ? { state: "missing", params: missing, sent: first.data }
    : { state: "ok", sent: first.data };
}

/** The pushed object as one line of evidence: {"event":"menu_click","link_text":"Coffee"}. */
export function asSent(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

export interface EventsRead {
  config: EventsConfig;
  targets: ClickTarget[];
  result: ObserveResult;
}

/** Targets, then the observer, once per run on first use. No observer: could not check. */
export function lazyEvents(opts: {
  page: PageSnapshot;
  config: EventsConfig;
  observer?: EventObserver;
}): () => Promise<EventsRead> {
  let pending: Promise<EventsRead> | undefined;
  return () =>
    (pending ??= (async () => {
      const targets = clickTargets(opts.page, opts.config);
      // Links only: what the observer is asked to click is the plan's links, and the rest is reported as not observed.
      const { click, skipped } = selectClickable(targets, opts.config, opts.page);
      let result: ObserveResult = opts.observer
        ? await opts.observer.observe({
            page: opts.page.finalUrl,
            targets: click,
            ...(opts.config.consent ? { consent: opts.config.consent } : {}),
            waitMs: EVENT_WAIT_MS,
          })
        : { unchecked: NO_OBSERVER };
      if ("clicks" in result && skipped.length > 0) {
        // An observer that already answered for a path (a recording does) is not overruled.
        const seen = new Set(result.clicks.map((c) => c.path));
        const seenPhone = new Set((result.phone ?? []).map((c) => c.path));
        const left = skipped.map((s) => ({
          path: s.path,
          pushes: [],
          blocked: [],
          unobserved: s.reason,
        }));
        result = {
          ...result,
          clicks: [...result.clicks, ...left.filter((c) => !seen.has(c.path))],
          ...(result.phone
            ? { phone: [...result.phone, ...left.filter((c) => !seenPhone.has(c.path))] }
            : {}),
        };
      }
      return { config: opts.config, targets, result };
    })());
}

/** An observer that answers from a recording (tests, and replaying a run). Makes no request. */
export function recordedObserver(recording: ObserveResult): EventObserver {
  return { observe: () => Promise.resolve(recording) };
}

/** Each target with what it sent, for the CSV export and the distinct check. */
export function observedEvents(read: EventsRead): {
  target: ClickTarget;
  rule: EventRule;
  verdict: ClickVerdict;
}[] {
  if ("unchecked" in read.result) return [];
  const byPath = new Map(read.result.clicks.map((c) => [c.path, c]));
  return read.targets.flatMap((target) => {
    const rule = read.config.events[target.rule];
    if (!rule) return [];
    return [{ target, rule, verdict: judgeClick(rule, byPath.get(target.path)) }];
  });
}
