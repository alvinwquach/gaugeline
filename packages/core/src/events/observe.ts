import { load, type CheerioAPI } from "cheerio/slim";
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
type DomElement = Parameters<NonNullable<Parameters<typeof createDomStream>[2]>>[0];

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

/** What the observer saw after clicking one target. */
export interface ObservedClick {
  path: string;
  /** Objects pushed to dataLayer after the click, each with ms since the click. */
  pushes: { atMs: number; data: Record<string, unknown> }[];
  /** Analytics requests intercepted and recorded, never delivered (their hosts only). */
  blocked: string[];
}

export type ObserveResult = { clicks: ObservedClick[] } | { unchecked: string };

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

/** A parameter counts as filled when it is a non-empty string, a number or a boolean. */
function filled(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  return typeof v === "number" || typeof v === "boolean";
}

export type ClickVerdict =
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
  const named = (click?.pushes ?? []).filter((p) => p.data.event === rule.event);
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
      const result: ObserveResult = opts.observer
        ? await opts.observer.observe({
            page: opts.page.finalUrl,
            targets,
            ...(opts.config.consent ? { consent: opts.config.consent } : {}),
            waitMs: EVENT_WAIT_MS,
          })
        : { unchecked: NO_OBSERVER };
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
