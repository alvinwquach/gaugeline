import { load, type CheerioAPI } from "cheerio/slim";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { Hop } from "../fetcher.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * Reading what a page shows, as sent without JavaScript. Page text is data: nothing here follows
 * an instruction in it, and anything printed is escaped by the caller.
 */

/** Elements that start and end a line of text. */
const BLOCK = new Set(
  "address article aside blockquote body dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol option p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);
/** Elements whose content is never shown as text. */
const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg"]);

/** Zero-width characters sites add for content source maps, and a stray byte order mark. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF]/g;

function hiddenStyle(style: string | undefined): boolean {
  return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(!important)?\s*(;|$)/i.test(
    style ?? "",
  );
}

type Nodes = ReturnType<ReturnType<CheerioAPI["root"]>["contents"]>;

function walk($: CheerioAPI, nodes: Nodes, out: string[]): void {
  nodes.each((_, node) => {
    const type = (node as { type: string }).type;
    if (type === "text") {
      out.push($(node).text());
      return;
    }
    if (type !== "tag") return;
    const name = (node as { name: string }).name.toLowerCase();
    const el = $(node);
    if (SKIP.has(name) || el.is("[hidden], [aria-hidden='true']") || hiddenStyle(el.attr("style")))
      return;
    if (name === "br") {
      out.push("\n");
      return;
    }
    const block = BLOCK.has(name);
    if (block) out.push("\n");
    walk($, el.contents(), out);
    if (block) out.push("\n");
  });
}

const cache = new WeakMap<object, string>();

/**
 * The text a visitor can read, one line per block of the page (a heading, a list item, a table
 * cell, an option of a menu): hidden elements, scripts and styles left out, spaces collapsed.
 */
export function visibleLines(page: PageSnapshot): string {
  const hit = cache.get(page);
  if (hit !== undefined) return hit;
  const $ = load(page.hops.at(-1)?.body ?? "");
  const out: string[] = [];
  walk($, $("body").length > 0 ? $("body").contents() : $.root().contents(), out);
  const text = out
    .join("")
    .replace(ZERO_WIDTH, "")
    .split("\n")
    .map((l) => l.replace(/[\s\u00A0]+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
  cache.set(page, text);
  return text;
}

/** Lower case with the accents taken off: an e with an accent and a plain e are one letter. */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface Token {
  /** The word as written. */
  text: string;
  /** The word folded: no accents, lower case. */
  key: string;
  start: number;
  end: number;
}

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

export function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    out.push({ text: m[0], key: fold(m[0]), start, end: start + m[0].length });
  }
  return out;
}

/** The text between two words has a break in it: punctuation, a symbol or the end of a line. */
function broken(gap: string): boolean {
  return /[^ \t\u00A0]/.test(gap);
}

/**
 * Whether the text says the phrase: the same words in a row, ignoring case, accents, spacing and
 * punctuation. The words may not be split across two lines (two blocks of the page).
 */
export function says(text: string, phrase: string): boolean {
  const want = tokens(phrase).map((t) => t.key);
  if (want.length === 0) return false;
  const have = tokens(text);
  for (let i = 0; i + want.length <= have.length; i++) {
    let same = true;
    for (let j = 0; j < want.length && same; j++) {
      same = have[i + j]?.key === want[j];
      if (same && j > 0 && /\n/.test(text.slice(have[i + j - 1]?.end, have[i + j]?.start)))
        same = false;
    }
    if (same) return true;
  }
  return false;
}

/**
 * The forms a word may be in, so a singular and its plural meet: "tamales" gives tamales, tamale
 * and tamal; "berries" gives berries and berry; "boxes" gives boxes, boxe and box.
 */
function stems(word: string): string[] {
  const out = [word];
  if (word.length > 3 && /\D/.test(word)) {
    if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
    if (word.endsWith("es")) out.push(word.slice(0, -2));
    if (word.endsWith("s") && !word.endsWith("ss")) out.push(word.slice(0, -1));
  }
  return out;
}

/** Two folded words are the same word, or one is the plural of the other. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const other = new Set(stems(b));
  return stems(a).some((s) => other.has(s));
}

/** The words of two names match one for one, ignoring case, accents and plurals. */
export function sameName(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  return (
    x.length > 0 && x.length === y.length && x.every((t, i) => sameWord(t.key, y[i]?.key ?? ""))
  );
}

/**
 * Where an item's name is listed in the text: the words of the name, in a row, standing on their
 * own (at the start of a line or after punctuation, and before punctuation, a number or the end of
 * the line). "Tamal" is found in "Tamal, pork - $12" and not in "Tamal de rajas $12", which is
 * another item. Returns the text as the page wrote it.
 */
export function findName(text: string, name: string): string[] {
  const want = tokens(name).map((t) => t.key);
  if (want.length === 0) return [];
  const have = tokens(text);
  const found: string[] = [];
  for (let i = 0; i + want.length <= have.length; i++) {
    let same = true;
    for (let j = 0; j < want.length && same; j++) {
      same = sameWord(have[i + j]?.key ?? "", want[j] ?? "");
      if (same && j > 0 && /\n/.test(text.slice(have[i + j - 1]?.end, have[i + j]?.start)))
        same = false;
    }
    if (!same) continue;
    const first = have[i];
    const last = have[i + want.length - 1];
    const before = have[i - 1];
    const after = have[i + want.length];
    if (!first || !last) continue;
    const startsAlone =
      !before || broken(text.slice(before.end, first.start)) || /^\p{N}+$/u.test(before.key);
    const endsAlone =
      !after || broken(text.slice(last.end, after.start)) || /^\p{N}+$/u.test(after.key);
    if (!startsAlone || !endsAlone) continue;
    const as = text.slice(first.start, last.end);
    if (!found.includes(as)) found.push(as);
  }
  return found;
}

/** A link on the page to a path or anything under it. */
export interface PathLink {
  path: string;
  text: string;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** Same-site links on the page to `target` or a path under it ("/order" covers "/order/checkout"). */
export function linksTo(page: PageSnapshot, target: string): PathLink[] {
  const want = trimSlash(target);
  const out: PathLink[] = [];
  for (const link of page.links) {
    if (!link.sameSite) continue;
    let path: string;
    try {
      path = trimSlash(new URL(link.href).pathname);
    } catch {
      continue;
    }
    if (path === want || (want !== "/" && path.startsWith(`${want}/`)))
      out.push({ path, text: link.text });
  }
  return out;
}

const MENU_ITEM = /(?:^|[/:])MenuItem$/;

function isMenuItem(type: unknown): boolean {
  return Array.isArray(type)
    ? type.some((t) => typeof t === "string" && MENU_ITEM.test(t))
    : typeof type === "string" && MENU_ITEM.test(type);
}

/** The names of the MenuItem nodes in the page's structured data, wherever they are nested. */
export function menuItemNames(page: Pick<PageSnapshot, "jsonLd">): string[] {
  const names: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (isMenuItem(obj["@type"])) {
      const name = obj.name;
      if (typeof name === "string" && name.trim() !== "") names.push(name.trim());
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  visit(page.jsonLd, 0);
  return [...new Set(names)];
}

/** Seconds as a short phrase: "40 seconds", "52 minutes", "2 hours 5 minutes". */
export function duration(seconds: number): string {
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48)
    return rest === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(rest, "minute")}`;
  return unit(Math.floor(hours / 24), "day");
}

/**
 * What a cache did to the answer (RFC 9111): the Age header says how long a shared cache (a CDN)
 * has held this copy. Empty when the response has none. The most common reason a switch is off and
 * the page still shows the old state is a cached copy, so a finding about a page carries this.
 */
export function cacheNote(hop: Hop | undefined): string {
  const age = hop?.headers.age;
  if (age === undefined || !/^\d{1,10}$/.test(age.trim())) return "";
  const seconds = Number(age.trim());
  const control = hop?.headers["cache-control"];
  return ` The answer was served from a cache: Age ${seconds} (${duration(seconds)} old)${control ? `, Cache-Control: ${escapeInvisible(control, 80)}` : ""}. It may show the old state until it expires or is purged.`;
}
