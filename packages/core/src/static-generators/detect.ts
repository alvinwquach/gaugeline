import type { PageSnapshot } from "../snapshot.js";

/**
 * Recognising a site built with a static generator, and reading what its pages say about drafts,
 * dates, versions and search, from the pages alone. Pure functions over bytes already fetched:
 * every scan is linear, and every size is capped (hostile HTML and JSON can be megabytes).
 *
 * Markers confirmed in the generators' own package source (docs.gohugo.io, jekyllrb.com and
 * 11ty.dev were not reachable from the build machine): Docusaurus (`@docusaurus/core` 3.10.2
 * writes `generator` as `Docusaurus v<version>`, and the development template writes `Docusaurus`
 * alone; `@docusaurus/theme-classic` writes `docusaurus_version` and the banner class names),
 * VitePress (1.6.4 writes `generator` as `VitePress v<version>`; its search index is the module
 * `@localSearchIndex<locale>`), Eleventy (`eleventy.generator` is `Eleventy v<version>`;
 * eleventy-dev-server injects `/.11ty/reload-client.js`). Hugo's and Jekyll's markers, the draft
 * badge class names and the `/index.json` family of search addresses are conventions of themes
 * and plugins: uncited.
 */

export type Generator = "hugo" | "jekyll" | "eleventy" | "docusaurus" | "vitepress";

/** The most HTML read for any scan: the head and the start of the body. */
export const HTML_SCAN_MAX = 300_000;
/** The largest search index read, in characters. */
export const INDEX_MAX = 5 * 1024 * 1024;
/** The most addresses an index may list before it is not read. */
export const INDEX_ENTRIES_MAX = 50_000;

const body = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, HTML_SCAN_MAX);
/** The page's body was cut at the fetcher's cap: nothing in it can be called absent. */
export const cutShort = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;

const metaCache = new WeakMap<PageSnapshot, Map<string, string>>();
/** Every meta tag's content by its name or property (lower case), the first of each. A Map: no key is special. */
function metas(page: PageSnapshot): Map<string, string> {
  const hit = metaCache.get(page);
  if (hit) return hit;
  const out = new Map<string, string>();
  let tags = 0;
  for (const m of body(page).matchAll(/<meta\b[^>]{0,1500}>/gi)) {
    if (++tags > 300) break;
    const tag = m[0];
    const key = /\b(?:name|property)\s*=\s*(["'])([^"']{1,80})\1/i.exec(tag)?.[2];
    const content = /\bcontent\s*=\s*(["'])([^"']{0,300})\1/i.exec(tag)?.[2];
    if (key !== undefined && content !== undefined && !out.has(key.toLowerCase()))
      out.set(key.toLowerCase(), content);
  }
  metaCache.set(page, out);
  return out;
}

/** The generator named by `<meta name="generator">`, with its version when the tag gives one. */
export function generatorOf(page: PageSnapshot): { name: Generator; version?: string } | undefined {
  const m = /^(hugo|jekyll|eleventy|docusaurus|vitepress)\b\s*v?(\d[\w.+-]{0,30})?/i.exec(
    metas(page).get("generator") ?? "",
  );
  if (!m?.[1]) return undefined;
  return { name: m[1].toLowerCase() as Generator, ...(m[2] ? { version: m[2] } : {}) };
}

const NOINDEX = /(^|[\s,:])(noindex|none)(\s*(,|$)|$)/i;
/** No noindex in the robots meta tag or the X-Robots-Tag header: a search engine may list the page. */
export function isIndexable(page: PageSnapshot): boolean {
  const header = page.hops.at(-1)?.headers["x-robots-tag"] ?? "";
  return !NOINDEX.test(page.metaRobots ?? "") && !NOINDEX.test(header);
}

/** The first of article:published_time and JSON-LD datePublished values, in that order, as written. */
export function pageDates(page: PageSnapshot): { source: string; raw: string }[] {
  const out: { source: string; raw: string }[] = [];
  const published = metas(page).get("article:published_time");
  if (published !== undefined) out.push({ source: "article:published_time", raw: published });
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || out.length > 20) return;
    if (Array.isArray(v)) for (const x of v.slice(0, 50)) walk(x, depth + 1);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Object.hasOwn(o, "datePublished") && typeof o.datePublished === "string")
        out.push({ source: "datePublished", raw: o.datePublished });
      if (Object.hasOwn(o, "@graph")) walk(o["@graph"], depth + 1);
    }
  };
  walk(page.jsonLd, 0);
  return out;
}

const WHEN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** An ISO date or date and time as milliseconds; no zone means UTC, so every machine agrees. Anything else: undefined. */
export function parseWhen(value: string): number | undefined {
  const v = value.trim();
  if (v.length > 40 || !WHEN.test(v)) return undefined;
  let iso = v.replace(" ", "T");
  if (!iso.includes("T")) iso += "T00:00:00Z";
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

const classTokens = (page: PageSnapshot): string[] => {
  const out: string[] = [];
  let n = 0;
  for (const m of body(page).matchAll(/\bclass\s*=\s*(?:"([^"]{0,500})"|'([^']{0,500})')/gi)) {
    if (++n > 20_000) break;
    for (const t of (m[1] ?? m[2] ?? "").split(/\s+/)) if (t !== "") out.push(t);
  }
  return out;
};

const DRAFT_CLASSES = new Set([
  "draft",
  "is-draft",
  "post-draft",
  "draft-badge",
  "badge-draft",
  "theme-draft-banner",
]);

/** A draft or unlisted marker the page itself shows: a class name, never page text. */
export function draftMarker(
  page: PageSnapshot,
): { kind: "draft" | "unlisted"; marker: string } | undefined {
  const tokens = classTokens(page);
  const draft = tokens.find((t) => DRAFT_CLASSES.has(t.toLowerCase()));
  if (draft !== undefined) return { kind: "draft", marker: `class "${draft.toLowerCase()}"` };
  const unlisted = tokens.find((t) => t === "theme-unlisted-banner");
  return unlisted ? { kind: "unlisted", marker: `class "${unlisted}"` } : undefined;
}

/** A Docusaurus page that wears the theme's banner for a version that is not the current one. */
export function versionBanner(
  page: PageSnapshot,
): { kind: "unmaintained" | "unreleased"; version?: string } | undefined {
  const html = body(page);
  const at = /\bclass\s*=\s*["'][^"']{0,500}\btheme-doc-version-banner\b/i.exec(html)?.index;
  if (at === undefined) return undefined;
  const near = html.slice(at, at + 800);
  const kind = /no longer actively maintained/i.test(near)
    ? "unmaintained"
    : /unreleased documentation/i.test(near)
      ? "unreleased"
      : undefined;
  if (!kind) return undefined;
  const v = metas(page).get("docusaurus_version");
  return { kind, ...(v !== undefined && /^[\w.+-]{1,40}$/.test(v) ? { version: v } : {}) };
}

/** Signs that a development server, not a build, answered: names of the markers only. */
export function devMarkers(page: PageSnapshot): string[] {
  const out: string[] = [];
  const has = (re: RegExp): boolean => page.scripts.some((s) => re.test(s));
  if (has(/\/livereload\.js(?:\?|$)/)) out.push("/livereload.js");
  if (has(/\/\.11ty\/reload-client\.js(?:\?|$)/)) out.push("/.11ty/reload-client.js");
  if (has(/\/@vite\/client(?:\?|$)/) && has(/vitepress/i)) out.push("/@vite/client");
  const g = generatorOf(page);
  if (g?.name === "docusaurus" && g.version === undefined)
    out.push("a Docusaurus generator tag with no version");
  return out;
}

/** A path the same way for a search index and a sitemap: this site only, no query, hash, .html or trailing slash. */
export function normalizePath(href: string, origin: string): string | undefined {
  let u: URL;
  try {
    u = new URL(href, `${origin}/`);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== new URL(origin).origin)
    return undefined;
  const p = u.pathname
    .replace(/\/index\.html?$/i, "/")
    .replace(/\.html?$/i, "")
    .replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

const ADDRESS_KEYS = ["permalink", "url", "uri", "href", "path", "relpermalink", "ref"] as const;
const LIST_KEYS = ["docs", "pages", "entries", "documents", "items", "posts"] as const;

/**
 * The page addresses a search index lists, as normalised paths of this site. Reads a JSON array of
 * objects with an address field, an object with a `docs`/`pages`/`entries` list, a lunr `store`, a
 * MiniSearch `documentIds` (VitePress local search, also as its `export default "<json>"` module).
 * Titles and text are never read. An index too big, too long, not JSON or of a shape not listed
 * is `unread` with the reason: never an empty pass.
 */
export function readSearchIndex(
  text: string,
  origin: string,
): { paths: string[] } | { unread: string } {
  if (text.length > INDEX_MAX) return { unread: "the search index is larger than is read" };
  let json: unknown;
  try {
    let src = text.trim();
    const mod = /^export\s+default\s+/.exec(src);
    if (mod) src = src.slice(mod[0].length).replace(/;\s*$/, "");
    json = JSON.parse(src);
    if (mod && typeof json === "string") json = JSON.parse(json);
  } catch {
    return { unread: "the search index is not JSON" };
  }
  const raw: string[] = [];
  const addItem = (item: unknown): void => {
    if (typeof item === "string") raw.push(item);
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      for (const k of ADDRESS_KEYS)
        if (Object.hasOwn(o, k) && typeof o[k] === "string") return void raw.push(o[k]);
      if (Object.hasOwn(o, "id") && typeof o.id === "string" && o.id.startsWith("/"))
        raw.push(o.id);
    }
  };
  const addList = (list: unknown): void => {
    if (Array.isArray(list)) for (const item of list) addItem(item);
  };
  if (Array.isArray(json)) addList(json);
  else if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of LIST_KEYS) if (Object.hasOwn(o, k)) addList(o[k]);
    const store = Object.hasOwn(o, "store") ? o.store : undefined;
    if (store && typeof store === "object")
      for (const k of Object.keys(store)) if (/^(?:\/|https?:)/.test(k)) raw.push(k);
    const ids = Object.hasOwn(o, "documentIds") ? o.documentIds : undefined;
    if (ids && typeof ids === "object")
      for (const v of Object.values(ids)) if (typeof v === "string") raw.push(v);
  }
  if (raw.length === 0)
    return { unread: "the search index has no list of addresses this check reads" };
  if (raw.length > INDEX_ENTRIES_MAX)
    return { unread: "the search index lists more than 50,000 addresses" };
  const paths = new Set<string>();
  for (const r of raw) {
    const p = normalizePath(r, origin);
    if (p !== undefined) paths.add(p);
  }
  return { paths: [...paths] };
}
