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
  images: {
    src: string;
    alt: string | null;
    width?: number;
    height?: number;
    /** The img's own srcset attribute, as written. */
    srcset?: string;
    /** <source> siblings when the img is inside a <picture>, in order. */
    sources?: { srcset: string; type?: string }[];
  }[];
  /** Parsed JSON-LD blocks; an array in one script tag becomes several blocks. */
  jsonLd: unknown[];
  jsonLdErrors: string[];
  /**
   * Every JSON-LD script tag in document order, as written: the parsed value, or for one that did
   * not parse its text and the parser's message. For the app's Search data view.
   */
  jsonLdBlocks?: ({ ok: true; value: unknown } | { ok: false; raw: string; error: string })[];
  /** The href of the first canonical link as written, trimmed: "" when the link has none. */
  canonicalAttr?: string;
  /** The first 200 words counted in `wordCount`, joined by single spaces. */
  firstWords?: string;
  og: Record<string, string>;
  scripts: string[];
  /** link rel="alternate" hreflang entries, in document order. */
  hreflang?: { hreflang: string; href: string }[];
  /** The html element's lang attribute. */
  htmlLang?: string;
  /** Calendar feeds: link rel="alternate" type="text/calendar", links ending .ics, webcal: links. */
  calendars?: string[];
  /** Elements marked as the next or upcoming event (by class, id or data attribute) with a time[datetime]. */
  nextCards?: { label: string; datetime: string }[];
  /** Microdata itemtype values, each URL of a whitespace-separated list, in document order. */
  itemTypes?: string[];
  /** The title and every meta content exactly as sent, before invisible characters are stripped. */
  rawText?: { title?: string; meta: string[] };
  /** The meta name="viewport" tag's content, wherever it is in the document. */
  viewport?: string;
  /** The apple-itunes-app meta tag's content (Smart App Banner), if any. */
  appleItunesApp?: string;
  /** Feeds the page advertises (link rel="alternate" with an RSS or Atom type), in document order. */
  feeds: { href: string; type: string; title?: string }[];
  forms: {
    action?: string;
    method?: string;
    hiddenFields: string[];
    /**
     * The name of every field the form submits (hidden, visible, select, textarea), once each, in
     * document order. Buttons, images, resets and file inputs are left out. Names only, never values.
     */
    fieldNames?: string[];
    position: number;
  }[];
  /**
   * Every iframe with an address (its src, or data-src when it loads lazily), in document order.
   * `position` is the element's index among every form, iframe and script element in the document.
   */
  iframes?: { src: string; position: number }[];
  /**
   * Every script element in document order: its address, or for an inline script the start of its
   * body (JavaScript types only, cut at INLINE_SCRIPT_MAX characters). `position` is counted as for
   * `iframes`, so a form and a tracking script can be put in order. `scripts` keeps the addresses alone.
   * `integrity` is set on a script with an address whose tag has a non-empty integrity attribute (SRI).
   */
  scriptTags?: { src?: string; inline?: string; integrity?: true; position: number }[];
  /**
   * Every button a visitor could press and every link, as written, in document order (at most
   * BUTTONS_MAX): a, button, input type submit, button or image, any role="button", and any element
   * with an onclick attribute. Elements that are hidden are left out. For the checkout checks.
   */
  buttons?: PageButton[];
  /**
   * The text a visitor can read without running JavaScript, on one line (script, style, noscript,
   * template and hidden elements left out), cut at VISIBLE_TEXT_MAX characters. For checks that look
   * for something written in the text, such as a price.
   */
  visibleText?: string;
  /** Every element id, for #anchor checks. */
  ids: Set<string>;
  /** Visible words without running JavaScript. */
  wordCount: number;
  /** Visible words outside the header, nav and footer (what thin-html reads). */
  contentWordCount: number;
  /** Sanity stega (zero-width) characters were found in the text and stripped. */
  stega: boolean;
}

/** One button, or link, as the page writes it. Nothing is resolved: `href` and `action` are the attributes. */
export interface PageButton {
  /** The tag: a, button, input (submit, button or image), or "other" for role="button" and onclick. */
  kind: "a" | "button" | "input" | "other";
  /** What it says: the text, or for an input its value, then aria-label or title. */
  text: string;
  /** a only: the href attribute, trimmed. Absent when the tag has no href. */
  href?: string;
  /** button and input: the type, lower case. A button with no type is "submit". */
  type?: string;
  /** button and input: the formaction attribute, trimmed. */
  formAction?: string;
  /** Set when the element is inside a form: the form's action attribute, trimmed, "" when it has none. */
  form?: { action: string };
  /** The element has an onclick attribute. */
  onclick: boolean;
}

/** The most buttons kept for one page. */
export const BUTTONS_MAX = 500;
/** The most visible text kept for one page. */
export const VISIBLE_TEXT_MAX = 100_000;
/** The longest button text kept. */
const BUTTON_TEXT_MAX = 200;

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

/** The text a visitor can read without JavaScript: one line, words separated by single spaces. */
function readableText($: CheerioAPI, state: { stega: boolean }, chrome = false): string {
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
  return clean(copy.text(), state);
}

/** The words `wordCount` counts, in order. */
function wordsOf(text: string): string[] {
  return text === "" ? [] : text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Is the element, or something around it, hidden from a visitor (hidden, aria-hidden, display:none)? */
function isHiddenElement($: CheerioAPI, el: Parameters<CheerioAPI>[0]): boolean {
  const self = $(el);
  if (self.closest("[hidden], [aria-hidden='true']").length > 0) return true;
  return (
    self
      .parents("[style]")
      .addBack("[style]")
      .filter((_, e) => isHiddenStyle($(e).attr("style"))).length > 0
  );
}

/** The input types that press a button. */
const BUTTON_INPUTS: ReadonlySet<string> = new Set(["submit", "button", "image"]);

/** How much of an inline script is kept: enough for an embed call, never a whole bundle. */
export const INLINE_SCRIPT_MAX = 16_384;

/** The script types a browser runs as JavaScript (an absent type is JavaScript). */
const JS_TYPES: ReadonlySet<string> = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "module",
]);

/** How many words a visitor can read without JavaScript. */
const FIRST_WORDS = 200;

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
    const srcset = $(el).attr("srcset")?.trim();
    const picture = $(el).parent().is("picture") ? $(el).parent() : undefined;
    const sources = picture
      ?.children("source")
      .map((_, s) => {
        const type = $(s).attr("type")?.trim().toLowerCase();
        return { srcset: ($(s).attr("srcset") ?? "").trim(), ...(type ? { type } : {}) };
      })
      .get()
      .filter((s) => s.srcset !== "");
    images.push({
      src,
      alt: alt === undefined ? null : alt,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(srcset ? { srcset } : {}),
      ...(sources && sources.length > 0 ? { sources } : {}),
    });
  });

  const jsonLd: unknown[] = [];
  const jsonLdErrors: string[] = [];
  const jsonLdBlocks: NonNullable<PageSnapshot["jsonLdBlocks"]> = [];
  $("script[type]").each((i, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase().split(";")[0]?.trim();
    if (type !== "application/ld+json") return;
    const raw = $(el).text().trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      jsonLdBlocks.push({ ok: true, value: parsed });
      if (Array.isArray(parsed)) jsonLd.push(...(parsed as unknown[]));
      else jsonLd.push(parsed);
    } catch (err) {
      jsonLdBlocks.push({
        ok: false,
        raw,
        error: err instanceof Error ? err.message : String(err),
      });
      jsonLdErrors.push(
        `JSON-LD block ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  const hreflang: { hreflang: string; href: string }[] = [];
  $("link[hreflang][href]").each((_, el) => {
    const rels = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    const href = resolve($(el).attr("href"), base);
    const code = ($(el).attr("hreflang") ?? "").trim();
    if (rels.includes("alternate") && href && code) hreflang.push({ hreflang: code, href });
  });
  const htmlLang = $("html").attr("lang")?.trim();

  const calendars: string[] = [];
  $("link[rel][href]").each((_, el) => {
    const rels = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    const type = ($(el).attr("type") ?? "").toLowerCase().split(";")[0]?.trim();
    const href = resolve($(el).attr("href"), base);
    if (href && rels.includes("alternate") && type === "text/calendar") calendars.push(href);
  });
  $("a[href]").each((_, el) => {
    const raw = ($(el).attr("href") ?? "").trim();
    if (/^webcal:\/\//i.test(raw)) calendars.push(raw);
    else {
      const href = resolve(raw, base);
      if (href && /\.ics$/i.test(new URL(href).pathname)) calendars.push(href);
    }
  });
  const NEXT = /(?:^|[-_\s])(?:next|upcoming)(?:[-_\s]|$)/i;
  const nextCards: { label: string; datetime: string }[] = [];
  $("*").each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    const marked = Object.entries(attribs).some(
      ([k, v]) =>
        ((k === "class" || k === "id") && NEXT.test(v)) ||
        (k.startsWith("data-") && NEXT.test(k.slice(5))),
    );
    if (!marked) return;
    const time = $(el).find("time[datetime]").first();
    const datetime = time.attr("datetime")?.trim();
    if (datetime) nextCards.push({ label: clean($(el).text(), state).slice(0, 80), datetime });
  });

  const itemTypes = $("[itemtype]")
    .map((_, el) => ($(el).attr("itemtype") ?? "").trim().split(/\s+/))
    .get()
    .filter((t: string) => t !== "");
  const rawMeta = $("meta[content]")
    .map((_, el) => $(el).attr("content") ?? "")
    .get()
    .filter((c: string) => c !== "");

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

  const appBanner = $("meta[name]")
    .filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "apple-itunes-app")
    .first()
    .attr("content")
    ?.trim();

  const viewport = $("meta[name]")
    .filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "viewport")
    .first()
    .attr("content");

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

  // One pass over every form, iframe and script, so `position` is the element's index in document order.
  const forms: PageSnapshot["forms"] = [];
  const iframes: NonNullable<PageSnapshot["iframes"]> = [];
  const scriptTags: NonNullable<PageSnapshot["scriptTags"]> = [];
  $("form, iframe, script").each((position, el) => {
    if (el.tagName === "form") {
      const action = resolve($(el).attr("action"), base);
      const method = $(el).attr("method")?.toLowerCase();
      const hiddenFields = $(el)
        .find("input")
        .filter((_, input) => ($(input).attr("type") ?? "").toLowerCase() === "hidden")
        .map((_, input) => $(input).attr("name") ?? "")
        .get()
        .filter((n) => n !== "");
      const fieldNames = [
        ...new Set(
          $(el)
            .find("input, select, textarea")
            .filter((_, field) => {
              const type = ($(field).attr("type") ?? "").toLowerCase();
              return !["submit", "button", "image", "reset", "file"].includes(type);
            })
            .map((_, field) => $(field).attr("name") ?? "")
            .get()
            .filter((n) => n !== ""),
        ),
      ];
      forms.push({
        ...(action ? { action } : {}),
        ...(method ? { method } : {}),
        hiddenFields,
        fieldNames,
        position,
      });
    } else if (el.tagName === "iframe") {
      const src = resolve($(el).attr("src") ?? $(el).attr("data-src"), base);
      if (src !== undefined) iframes.push({ src, position });
    } else {
      const src = resolve($(el).attr("src"), base);
      if (src !== undefined) {
        const integrity = ($(el).attr("integrity") ?? "").trim() !== "";
        scriptTags.push({ src, ...(integrity ? { integrity: true as const } : {}), position });
        return;
      }
      const type = ($(el).attr("type") ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
      const inline = $(el).text().slice(0, INLINE_SCRIPT_MAX);
      if (JS_TYPES.has(type) && inline.trim() !== "") scriptTags.push({ inline, position });
    }
  });

  const ids = new Set<string>();
  $("[id]").each((_, el) => {
    const id = $(el).attr("id");
    if (id) ids.add(id);
  });

  const buttons: PageButton[] = [];
  $("a, button, input, [role='button'], [onclick]").each((_, el) => {
    if (buttons.length >= BUTTONS_MAX) return false;
    const tag = el.tagName;
    const self = $(el);
    const inputType = ($(el).attr("type") ?? "").toLowerCase();
    if (tag === "input" && !BUTTON_INPUTS.has(inputType)) return;
    if (isHiddenElement($, el)) return;
    const kind: PageButton["kind"] =
      tag === "a" ? "a" : tag === "button" ? "button" : tag === "input" ? "input" : "other";
    const text =
      (tag === "input"
        ? clean(self.attr("value") ?? self.attr("alt") ?? "", state)
        : clean(self.text(), state)) ||
      clean(self.attr("aria-label") ?? self.attr("title") ?? "", state);
    const form = self.closest("form");
    const formAction = self.attr("formaction")?.trim();
    const href = self.attr("href")?.trim();
    buttons.push({
      kind,
      text: text.slice(0, BUTTON_TEXT_MAX),
      ...(kind === "a" && href !== undefined ? { href } : {}),
      ...(kind === "button" ? { type: self.attr("type")?.trim().toLowerCase() || "submit" } : {}),
      ...(kind === "input" ? { type: inputType } : {}),
      ...((kind === "button" || kind === "input") && formAction !== undefined
        ? { formAction }
        : {}),
      ...(form.length > 0 ? { form: { action: (form.attr("action") ?? "").trim() } } : {}),
      onclick: self.attr("onclick") !== undefined,
    });
  });

  const text = readableText($, state);
  const readable = wordsOf(text);
  const wordCount = readable.length;
  const contentWordCount = wordsOf(readableText($, state, true)).length;
  const canonicalLink = $("link[rel]")
    .filter((_, el) => ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"))
    .first();
  const canonicalAttr =
    canonicalLink.length > 0 ? ($(canonicalLink).attr("href") ?? "").trim() : undefined;
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
    jsonLdBlocks,
    ...(canonicalAttr === undefined ? {} : { canonicalAttr }),
    firstWords: readable.slice(0, FIRST_WORDS).join(" "),
    og,
    scripts,
    ...(appBanner ? { appleItunesApp: appBanner } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    itemTypes,
    calendars,
    nextCards,
    hreflang,
    ...(htmlLang ? { htmlLang } : {}),
    rawText: { ...($("title").length > 0 ? { title: titleText } : {}), meta: rawMeta },
    feeds,
    forms,
    iframes,
    scriptTags,
    buttons,
    visibleText: text.slice(0, VISIBLE_TEXT_MAX),
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
