import { load, type CheerioAPI } from "cheerio/slim";
import { isSameSite } from "../sample.js";
import type { PageSnapshot } from "../snapshot.js";
import type { TagCondition, TagContainer, TagSubject, TagTrigger } from "./read-container.js";

/** One trigger, judged against the pages the run read. */
export type TriggerVerdict =
  | { trigger: TagTrigger; state: "can-fire" }
  | { trigger: TagTrigger; state: "dead"; rule: string; where: string; nearest?: string }
  | { trigger: TagTrigger; state: "unchecked"; reason: string };

export interface TagAnalysis {
  container: TagContainer;
  /** Every trigger, in the export's order (All Pages first when tags use it). */
  verdicts: TriggerVerdict[];
  /** How many pages were read for elements (the checked page and the run's other pages). */
  pagesRead: number;
}

export interface TagSummary {
  publicId?: string;
  triggers: number;
  canFire: number;
  dead: number;
  unchecked: number;
}

const PAGE_SUBJECTS: ReadonlySet<TagSubject> = new Set(["page-url", "page-path", "page-hostname"]);

/** The value a condition compares, read from one address. */
function addressValue(subject: TagSubject, url: string): string {
  const u = new URL(url);
  if (subject === "page-path") return u.pathname;
  if (subject === "page-hostname") return u.hostname;
  u.hash = "";
  return u.href;
}

/** True when `actual` meets the condition. CSS conditions are tested by the caller. */
export function compare(c: TagCondition, actual: string): boolean {
  const a = c.ignoreCase ? actual.toLowerCase() : actual;
  const v = c.ignoreCase ? c.value.toLowerCase() : c.value;
  let hit: boolean;
  switch (c.operator) {
    case "equals":
      hit = a === v;
      break;
    case "contains":
      hit = a.includes(v);
      break;
    case "starts-with":
      hit = a.startsWith(v);
      break;
    case "ends-with":
      hit = a.endsWith(v);
      break;
    case "regex":
      hit = new RegExp(c.value, c.ignoreCase ? "i" : "").test(actual);
      break;
    case "css":
      hit = false;
      break;
  }
  return c.negate ? !hit : hit;
}

/** Edit distance, for "the nearest thing that does exist". Inputs are capped at 200 characters. */
export function distance(a: string, b: string): number {
  const s = a.slice(0, 200);
  const t = b.slice(0, 200);
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    for (let j = 1; j <= t.length; j++)
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[t.length] ?? 0;
}

/** The candidate closest to `target`; ties go to the alphabetically first, so runs agree. */
export function nearest(target: string, candidates: Iterable<string>): string | undefined {
  let best: { value: string; d: number } | undefined;
  for (const value of new Set(candidates)) {
    if (value === "") continue;
    const d = distance(target, value);
    if (!best || d < best.d || (d === best.d && value < best.value)) best = { value, d };
  }
  return best?.value;
}

/** One element a click or form trigger could fire on, with the values its variables read. */
interface Element {
  values: Partial<Record<TagSubject, string>>;
  is(selector: string): boolean;
}

interface ParsedPage {
  url: string;
  $: CheerioAPI;
}

function resolve(href: string | undefined, base: string): string {
  if (!href) return "";
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return "";
  }
}

function elements(page: ParsedPage, trigger: TagTrigger): Element[] {
  const { $, url } = page;
  const selector =
    trigger.kind === "form-submit" ? "form" : trigger.kind === "link-click" ? "a[href]" : "body *";
  const out: Element[] = [];
  $(selector).each((_, el) => {
    const node = $(el);
    const text = node.text().replace(/\s+/g, " ").trim();
    const id = node.attr("id") ?? "";
    const classes = (node.attr("class") ?? "").replace(/\s+/g, " ").trim();
    const values: Partial<Record<TagSubject, string>> =
      trigger.kind === "form-submit"
        ? {
            "form-url": resolve(node.attr("action"), url) || url,
            "form-id": id,
            "form-classes": classes,
            "form-text": text,
          }
        : {
            "click-url": resolve(node.attr("href"), url),
            "click-id": id,
            "click-classes": classes,
            "click-text": text,
          };
    out.push({ values, is: (s) => node.is(s) });
  });
  return out;
}

function meets(c: TagCondition, e: Element): boolean {
  if (c.operator === "css") {
    const hit = e.is(c.value);
    return c.negate ? !hit : hit;
  }
  return compare(c, e.values[c.subject] ?? "");
}

/** Folders sites keep downloads in, and a file extension: a rule naming one is about a file. */
const FILE_RULE =
  /(?:^|\/)(?:wp-content|uploads|files|downloads?|media|assets|documents?)(?:\/|$)|\.[a-z0-9]{2,4}\$?$/i;
/** An address that is a file to download, not a page. */
const FILE_LINK = /\.(?!html?$|php$|aspx?$)[a-z0-9]{2,4}$/i;

/** What a failed condition is compared with, for the nearest thing that exists. */
function candidatesFor(c: TagCondition, all: Element[], origin: string): string[] {
  if (c.operator === "css")
    return all.flatMap((e) => {
      const id = e.values["click-id"] ?? e.values["form-id"] ?? "";
      return id ? [`#${id}`] : [];
    });
  const values = all.map((e) => {
    const v = e.values[c.subject] ?? "";
    return c.subject.endsWith("-url") ? short(v, origin) : v;
  });
  // A rule about a download is compared with the links to files, when the pages have any.
  if (c.subject.endsWith("-url") && FILE_RULE.test(c.value)) {
    const files = values.filter((v) => FILE_LINK.test(v.split(/[?#]/)[0] ?? ""));
    if (files.length > 0) return files;
  }
  return values;
}

function short(url: string, origin: string): string {
  try {
    const u = new URL(url);
    return u.origin === origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "page-view": "page view",
  click: "click",
  "link-click": "link click",
  "form-submit": "form submission",
  "custom-event": "custom event",
});

export function kindWords(t: TagTrigger): string {
  return t.kind ? (KIND_WORDS[t.kind] ?? t.type) : t.type;
}

export interface AnalyseInput {
  container: TagContainer;
  /** The pages read: their elements are what click and form rules are compared with. */
  pages: readonly PageSnapshot[];
  /** Other addresses known to exist on the site (sitemap entries, same-site links), not read. */
  known?: readonly string[];
}

/** Judge every trigger. Pure: the same container and pages give the same verdicts. */
export function analyseTags({ container, pages, known = [] }: AnalyseInput): TagAnalysis {
  const site = pages[0]?.finalUrl ?? "";
  const origin = site ? new URL(site).origin : "";
  const read: ParsedPage[] = pages.map((p) => ({
    url: p.finalUrl,
    $: load((p.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, "")),
  }));
  const readUrls = new Set(read.map((p) => strip(p.url)));
  const addresses = new Set(readUrls);
  for (const p of pages) for (const l of p.links) if (l.sameSite) addresses.add(strip(l.href));
  for (const u of known) if (safeSameSite(u, site)) addresses.add(strip(u));

  const verdicts = container.triggers.map((trigger): TriggerVerdict => {
    if (trigger.unreadable) return { trigger, state: "unchecked", reason: trigger.unreadable };
    const pageRules = trigger.conditions.filter((c) => PAGE_SUBJECTS.has(c.subject));
    const others = trigger.conditions.filter((c) => !PAGE_SUBJECTS.has(c.subject));
    if (pageRules.some((c) => c.operator === "css"))
      return {
        trigger,
        state: "unchecked",
        reason: "a page variable is compared with a CSS selector",
      };
    if (trigger.kind === "custom-event")
      return {
        trigger,
        state: "unchecked",
        reason:
          "custom events are pushed by the site's own scripts, which a read without JavaScript doesn't run",
      };
    if (trigger.kind === "page-view" && others.length > 0)
      return {
        trigger,
        state: "unchecked",
        reason: "a page view trigger reads click or form variables",
      };
    const admits = (url: string) =>
      pageRules.every((c) => compare(c, addressValue(c.subject, url)));
    const admitted = [...addresses].filter(admits);
    if (admitted.length === 0) {
      const failing =
        pageRules.find(
          (c) => ![...addresses].some((u) => compare(c, addressValue(c.subject, u))),
        ) ?? pageRules[0];
      const rule = failing?.text ?? "";
      const pool = [...addresses].map((u) =>
        failing?.subject === "page-path"
          ? new URL(u).pathname
          : failing?.subject === "page-hostname"
            ? new URL(u).hostname
            : u,
      );
      const near = failing && !failing.negate ? nearest(failing.value, pool) : undefined;
      return {
        trigger,
        state: "dead",
        rule,
        where: `no page on the site (${addresses.size} address${addresses.size === 1 ? "" : "es"} known)`,
        ...(near ? { nearest: near } : {}),
      };
    }
    if (trigger.kind === "page-view") return { trigger, state: "can-fire" };
    // Click and form rules are compared with the elements of the pages read that the trigger
    // allows. A trigger limited to pages the run didn't read is unchecked, never called dead.
    const onPages = read.filter((p) => admits(p.url));
    if (onPages.length === 0)
      return {
        trigger,
        state: "unchecked",
        reason: `it fires only on pages this run did not read (${short(admitted[0] ?? "", origin)})`,
      };
    const all = onPages.flatMap((p) => elements(p, trigger));
    let selectorError: string | undefined;
    const safeMeets = (c: TagCondition, e: Element) => {
      try {
        return meets(c, e);
      } catch {
        selectorError ??= `"${c.value}" is not a CSS selector this can read`;
        return false;
      }
    };
    if (all.some((e) => others.every((c) => safeMeets(c, e))))
      return { trigger, state: "can-fire" };
    if (selectorError) return { trigger, state: "unchecked", reason: selectorError };
    const failing = others.find((c) => !all.some((e) => safeMeets(c, e)));
    const what =
      trigger.kind === "form-submit" ? "form" : trigger.kind === "link-click" ? "link" : "element";
    const where = `no ${what} on the ${onPages.length} page${onPages.length === 1 ? "" : "s"} read`;
    if (!failing)
      return {
        trigger,
        state: "dead",
        rule: others.map((c) => c.text).join(" and "),
        where: `no single ${what} meets every condition on the ${onPages.length} page${onPages.length === 1 ? "" : "s"} read`,
      };
    const near = failing.negate
      ? undefined
      : nearest(
          failing.operator === "css"
            ? failing.value
            : failing.subject.endsWith("-url")
              ? short(failing.value, origin)
              : failing.value,
          candidatesFor(failing, all, origin),
        );
    return {
      trigger,
      state: "dead",
      rule: failing.text,
      where,
      ...(near ? { nearest: near } : {}),
    };
  });
  return { container, verdicts, pagesRead: read.length };
}

function strip(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function safeSameSite(url: string, site: string): boolean {
  try {
    return site !== "" && isSameSite(url, site);
  } catch {
    return false;
  }
}

export function summarise(a: TagAnalysis): TagSummary {
  const count = (s: TriggerVerdict["state"]) => a.verdicts.filter((v) => v.state === s).length;
  return {
    ...(a.container.publicId ? { publicId: a.container.publicId } : {}),
    triggers: a.verdicts.length,
    canFire: count("can-fire"),
    dead: count("dead"),
    unchecked: count("unchecked"),
  };
}

/** "Tag rules: read 8 triggers from GTM-TEST01; 4 can fire, 2 cannot, 2 could not be checked." */
export function formatTagSummary(s: TagSummary): string {
  const from = s.publicId ? ` from ${s.publicId}` : "";
  const parts = [`${s.canFire} can fire`];
  if (s.dead > 0) parts.push(`${s.dead} cannot`);
  if (s.unchecked > 0) parts.push(`${s.unchecked} could not be checked`);
  return `Tag rules: read ${s.triggers} trigger${s.triggers === 1 ? "" : "s"}${from}; ${parts.join(", ")}.`;
}

/** Pairs of live tags that send the same thing on a trigger they share. */
export interface DuplicateTags {
  trigger: TagTrigger;
  tags: [string, string, ...string[]];
  label: string;
}

export function duplicateTags(container: TagContainer): DuplicateTags[] {
  const byTrigger = new Map(container.triggers.map((t) => [t.id, t]));
  // trigger id -> what is sent -> the tags sending it. Maps keep the export's order.
  const groups = new Map<string, Map<string, { names: string[]; label: string }>>();
  for (const tag of container.tags) {
    if (tag.paused) continue;
    for (const id of new Set(tag.firing)) {
      const bySend = groups.get(id) ?? new Map<string, { names: string[]; label: string }>();
      groups.set(id, bySend);
      const g = bySend.get(tag.sends) ?? { names: [], label: tag.label };
      g.names.push(tag.name);
      bySend.set(tag.sends, g);
    }
  }
  const out: DuplicateTags[] = [];
  for (const [id, bySend] of groups) {
    const trigger = byTrigger.get(id);
    if (!trigger) continue;
    for (const g of bySend.values()) {
      const [a, b, ...rest] = g.names;
      if (a !== undefined && b !== undefined)
        out.push({ trigger, tags: [a, b, ...rest], label: g.label });
    }
  }
  return out;
}

/** The analysis once per run, on first use; peek() says whether a check asked for it. */
export function lazyTagAnalysis(read: () => Promise<AnalyseInput>): {
  (): Promise<TagAnalysis>;
  peek(): Promise<TagAnalysis> | undefined;
} {
  let pending: Promise<TagAnalysis> | undefined;
  const get = () => (pending ??= read().then(analyseTags));
  return Object.assign(get, { peek: () => pending });
}
