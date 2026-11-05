import { load, type CheerioAPI } from "cheerio/slim";
import type { Hop } from "./fetcher.js";

/**
 * Everything a page check reads, parsed once from the fetched HTML. Built without running any
 * JavaScript: this is the page as a crawler receives it.
 */
export interface PageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  hops: Hop[];
  title?: string;
  /** The first canonical; every canonical is kept in `canonicals`. */
  canonical?: string;
  canonicals: string[];
  metaRobots?: string;
  headings: { level: 1 | 2 | 3; text: string; id?: string }[];
  links: { href: string; text: string; rel?: string; sameSite: boolean }[];
  images: { src: string; alt: string | null; width?: number; height?: number }[];
  /** Parsed JSON-LD blocks; an array in one script tag becomes several blocks. */
  jsonLd: unknown[];
  jsonLdErrors: string[];
  og: Record<string, string>;
  scripts: string[];
  /** Feeds the page advertises (link rel="alternate" with an RSS or Atom type), in document order. */
  feeds: { href: string; type: string; title?: string }[];
  forms: { action?: string; method?: string; hiddenFields: string[] }[];
  /** Every element id, for #anchor checks. */
  ids: Set<string>;
  /** Visible words without running JavaScript. */
  wordCount: number;
  /** Visible words outside the header, nav and footer (what thin-html reads). */
  contentWordCount: number;
  /** Sanity stega (zero-width) characters were found in the text and stripped. */
  stega: boolean;
}

/** Zero-width characters used by content source maps (stega) and stray BOMs. */
const STEGA = /(?:\u200B|\u200C|\u200D|\u2060|\u2061|\u2062|\u2063|\u2064|\uFEFF)/g;
const STEGA_TEST = /(?:\u200B|\u200C|\u200D|\u2060|\u2061|\u2062|\u2063|\u2064|\uFEFF)/;

function clean(text: string, state: { stega: boolean }): string {
  if (STEGA_TEST.test(text)) state.stega = true;
  return text.replace(STEGA, "").replace(/\s+/g, " ").trim();
}

/** The link types that advertise a feed. */
const FEED_TYPES: ReadonlySet<string> = new Set(["application/rss+xml", "application/atom+xml"]);

function resolve(href: string | undefined, base: string): string | undefined {
  if (href === undefined) return undefined;
  const trimmed = href.trim();
  if (trimmed === "") return undefined;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return undefined;
  }
}

function siteHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 && String(n) === value.trim().replace(/px$/, "")
    ? n
    : undefined;
}

function isHiddenStyle(style: string | undefined): boolean {
  return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)\s*(!important)?\s*(;|$)/i.test(
    style ?? "",
  );
}

function countWords($: CheerioAPI, state: { stega: boolean }, chrome = false): number {
  // htmlparser2 does not invent a <body>, so a fragment is wrapped to make find() see top-level tags.
  const copy =
    $("body").length > 0 ? $("body").clone() : $("<div></div>").append($.root().contents().clone());
  copy.find("script, style, noscript, template, [hidden], [aria-hidden='true']").remove();
  if (chrome)
    copy
      .find("header, nav, footer, [role='banner'], [role='navigation'], [role='contentinfo']")
      .remove();
  copy.find("[style]").each((_, el) => {
    if (isHiddenStyle($(el).attr("style"))) $(el).remove();
  });
  // Separate block text so "<p>a</p><p>b</p>" counts two words.
  copy.find("*").each((_, el) => {
    $(el).prepend(" ").append(" ");
  });
  const text = clean(copy.text(), state);
  return text === "" ? 0 : text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function buildSnapshot(hops: Hop[]): PageSnapshot {
  const first = hops[0];
  const last = hops.at(-1);
  if (!first || !last) throw new TypeError("buildSnapshot needs at least one hop.");
  const finalUrl = last.url;
  const html = (last.body ?? "").replace(/^\uFEFF/, "");
  const $ = load(html, { xml: false });
  const state = { stega: false };

  const baseHref = $("base[href]").first().attr("href");
  const base = resolve(baseHref, finalUrl) ?? finalUrl;
  const finalSite = siteHost(finalUrl);

  const titleText = $("title").first().text();
  const canonicals = $("link[rel]")
    .filter((_, el) => ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))
    .map((_, el) => resolve($(el).attr("href"), base))
    .get()
    .filter((h): h is string => h !== undefined);

  const robots = $("meta[name]")
    .filter((_, el) => ["robots", "googlebot"].includes(($(el).attr("name") ?? "").toLowerCase()))
    .map((_, el) => ($(el).attr("content") ?? "").trim())
    .get()
    .filter((c) => c !== "");

  const headings: PageSnapshot["headings"] = [];
  $("h1, h2, h3").each((_, el) => {
    const level = Number(el.tagName.slice(1)) as 1 | 2 | 3;
    const id = $(el).attr("id");
    headings.push({ level, text: clean($(el).text(), state), ...(id ? { id } : {}) });
  });

  const links: PageSnapshot["links"] = [];
  $("a[href]").each((_, el) => {
    const href = resolve($(el).attr("href"), base);
    if (href === undefined) return;
    const rel = $(el).attr("rel");
    const host = siteHost(href);
    links.push({
      href,
      text: clean($(el).text(), state),
      ...(rel ? { rel } : {}),
      sameSite: host !== undefined && host === finalSite,
    });
  });

  const images: PageSnapshot["images"] = [];
  $("img").each((_, el) => {
    const src = resolve($(el).attr("src"), base);
    if (src === undefined) return;
    const alt = $(el).attr("alt");
    const width = positiveInt($(el).attr("width"));
    const height = positiveInt($(el).attr("height"));
    images.push({
      src,
      alt: alt === undefined ? null : alt,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    });
  });

  const jsonLd: unknown[] = [];
  const jsonLdErrors: string[] = [];
  $("script[type]").each((i, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase().split(";")[0]?.trim();
    if (type !== "application/ld+json") return;
    const raw = $(el).text().trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) jsonLd.push(...(parsed as unknown[]));
      else jsonLd.push(parsed);
    } catch (err) {
      jsonLdErrors.push(
        `JSON-LD block ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const og: Record<string, string> = {};
  $("meta[property]").each((_, el) => {
    const property = ($(el).attr("property") ?? "").trim().toLowerCase();
    if (property.startsWith("og:") && og[property] === undefined)
      og[property] = $(el).attr("content") ?? "";
  });

  const scripts = $("script[src]")
    .map((_, el) => resolve($(el).attr("src"), base))
    .get()
    .filter((s): s is string => s !== undefined);

  const feeds: PageSnapshot["feeds"] = [];
  $("link[rel][href]").each((_, el) => {
    const rels = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    const type = ($(el).attr("type") ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
    if (!rels.includes("alternate") || !FEED_TYPES.has(type)) return;
    const href = resolve($(el).attr("href"), base);
    if (href === undefined) return;
    const title = $(el).attr("title");
    feeds.push({ href, type, ...(title ? { title: clean(title, state) } : {}) });
  });

  const forms: PageSnapshot["forms"] = [];
  $("form").each((_, el) => {
    const action = resolve($(el).attr("action"), base);
    const method = $(el).attr("method")?.toLowerCase();
    const hiddenFields = $(el)
      .find("input")
      .filter((_, input) => ($(input).attr("type") ?? "").toLowerCase() === "hidden")
      .map((_, input) => $(input).attr("name") ?? "")
      .get()
      .filter((n) => n !== "");
    forms.push({ ...(action ? { action } : {}), ...(method ? { method } : {}), hiddenFields });
  });

  const ids = new Set<string>();
  $("[id]").each((_, el) => {
    const id = $(el).attr("id");
    if (id) ids.add(id);
  });

  const wordCount = countWords($, state);
  const contentWordCount = countWords($, state, true);
  const title = titleText === "" && $("title").length === 0 ? undefined : clean(titleText, state);

  return {
    requestedUrl: first.fallbackFrom ?? first.url,
    finalUrl,
    status: last.status,
    hops,
    ...(title === undefined ? {} : { title }),
    ...(canonicals[0] === undefined ? {} : { canonical: canonicals[0] }),
    canonicals,
    ...(robots.length === 0 ? {} : { metaRobots: robots.join(", ") }),
    headings,
    links,
    images,
    jsonLd,
    jsonLdErrors,
    og,
    scripts,
    feeds,
    forms,
    ids,
    wordCount,
    contentWordCount,
    stega: state.stega,
  };
}

/** Every JSON-LD node, with @graph members lifted out. */
export function jsonLdNodes(snapshot: Pick<PageSnapshot, "jsonLd">): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
      else out.push(obj);
    }
  };
  visit(snapshot.jsonLd);
  return out;
}
