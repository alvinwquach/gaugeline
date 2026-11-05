import { load, type CheerioAPI } from "cheerio/slim";
import type { PageSnapshot } from "../../snapshot.js";

/** One link, with the region it sits in and its accessible name. */
export interface ContentLink {
  href: string;
  /** The link text; for an icon-only link, its aria-label (or an image's alt). */
  name: string;
  region: "nav" | "header" | "footer" | "main";
}

/** What the content checks read, parsed once per page from the HTML already fetched. */
export interface ContentIndex {
  /** title elements outside svg. */
  titles: string[];
  h1s: string[];
  /** Visible text of the main content (main, else body), without code, pre, script, style or svg. */
  mainText: string;
  links: ContentLink[];
  /** img src values, resolved. */
  images: string[];
}

const SKIP = "script, style, noscript, template, code, pre, svg";

function text($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
  const copy = $(el).clone();
  copy.find(SKIP).remove();
  // .text() runs adjacent elements together ("TitleNext paragraph"): give each one a trailing space.
  copy.find("*").each((_, child) => {
    $(child).append(" ");
  });
  return copy.text().replace(/\s+/g, " ").trim();
}

/** Accessible name, simplified: aria-label, else the text, else the alt of an image inside. */
function linkName($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
  const aria = $(el).attr("aria-label")?.trim();
  if (aria) return aria;
  const t = text($, el);
  if (t) return t;
  return ($(el).find("img[alt]").first().attr("alt") ?? "").trim();
}

const cache = new WeakMap<object, ContentIndex>();

/** Parse the page's final HTML once; the result is cached for every content check. */
export function contentIndex(page: Pick<PageSnapshot, "hops" | "finalUrl">): ContentIndex {
  const hit = cache.get(page);
  if (hit) return hit;
  const html = (page.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, "");
  const $ = load(html);
  const resolve = (href: string | undefined) => {
    if (!href) return undefined;
    try {
      return new URL(href.trim(), page.finalUrl).href;
    } catch {
      return undefined;
    }
  };
  const titles = $("title")
    .filter((_, el) => $(el).parents("svg").length === 0)
    .map((_, el) => $(el).text().trim())
    .get();
  const h1s = $("h1")
    .map((_, el) => text($, el))
    .get();
  const main = $("main").first();
  const mainText = text($, main.length > 0 ? main.get(0) : ($("body").get(0) ?? $.root().get(0)));
  const links: ContentLink[] = [];
  $("a[href]").each((_, el) => {
    const href = resolve($(el).attr("href"));
    if (!href) return;
    const region =
      $(el).closest("nav").length > 0
        ? "nav"
        : $(el).closest("header").length > 0
          ? "header"
          : $(el).closest("footer").length > 0
            ? "footer"
            : "main";
    links.push({ href, name: linkName($, el), region });
  });
  const images = $("img[src]")
    .map((_, el) => resolve($(el).attr("src")))
    .get()
    .filter((s: string | undefined): s is string => s !== undefined);
  const index = { titles, h1s, mainText, links, images };
  cache.set(page, index);
  return index;
}

/** Labels compare without case, extra spaces or trailing arrows. */
export function normaliseLabel(label: string): string {
  return label
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/[\s→›»>….:!]+$/u, "")
    .trim()
    .toLowerCase();
}

/** A destination for the menu index: the address without its trailing slash; a #fragment is kept. */
export function navKey(href: string): string {
  try {
    const u = new URL(href);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.href;
  } catch {
    return href;
  }
}

/**
 * The menu index: normalised href -> the labels it is given across nav, header and footer.
 * A Map keeps first-seen order; a Set holds each label once. Any entry with more than one label
 * is nav-label-drift, and the homepage's entry is what nav-home-links reads.
 */
export function collectNav(index: Pick<ContentIndex, "links">): Map<string, Set<string>> {
  const nav = new Map<string, Set<string>>();
  for (const l of index.links) {
    if (l.region === "main" || l.name === "") continue;
    const key = navKey(l.href);
    const labels = nav.get(key) ?? new Set<string>();
    labels.add(l.name.replace(/\s+/g, " ").trim());
    nav.set(key, labels);
  }
  return nav;
}
