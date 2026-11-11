import type { PageSnapshot } from "../snapshot.js";

/**
 * Gatsby, from what a page already says. Every address and marker here is read from the `gatsby`
 * package source (npm, 5.14.4) and `gatsby-graphiql-explorer` (3.14.0), not remembered:
 *  - the HTML has `<meta name="generator" content="Gatsby <version>">` and a `<div id="___gatsby">`
 *    root (cache-dir/static-entry.js, default-html.js), and an inline
 *    `window.pagePath="..."; window.___webpackCompilationHash="...";` script;
 *  - a page's data is `<prefix>/page-data/<path or index>/page-data.json` and starts
 *    `{"componentChunkName":..,"path":..,"result":{"data":..,"pageContext":..},"staticQueryHashes":[..]}`
 *    (cache-dir/loader.js, dist/utils/page-data-helpers.js); the build number is
 *    `page-data/app-data.json`; a static query's result is `page-data/sq/d/<hash>.json`, `{"data":..}`;
 *  - `gatsby develop` serves unhashed `/commons.js` and `/framework.js` and `/socket.io/socket.io.js`
 *    (cache-dir/develop-static-entry.js) and a GraphiQL page at `/___graphql`, titled
 *    `Gatsby - GraphiQL` (gatsby-graphiql-explorer); a production build serves neither.
 * Everything is a linear scan over a capped slice of the body: no backtracking patterns.
 */

/** The most characters of a page's HTML read. */
export const SCAN_MAX = 400_000;
/** The most characters of an embedded or fetched payload read. */
export const DATA_MAX = 1_000_000;
/** The most fields kept from one payload. */
export const FIELDS_MAX = 2_000;
/** The most static queries read for one page. */
export const QUERIES_MAX = 10;
const DEPTH_MAX = 8;
const VISITS_MAX = 20_000;

const bodyOf = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, SCAN_MAX);
const isTruncated = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;

/** A Gatsby site, from its markup: the generator meta, the `___gatsby` root, or the inline globals. */
export function isGatsbySite(page: PageSnapshot): boolean {
  const body = bodyOf(page);
  if (body.includes('id="___gatsby"') || body.includes("id='___gatsby'")) return true;
  if (body.includes("window.___webpackCompilationHash")) return true;
  let from = 0;
  for (let tries = 0; tries < 5; tries += 1) {
    const at = body.indexOf('name="generator"', from);
    if (at < 0) break;
    const near = body.slice(Math.max(0, at - 100), at + 200);
    if (/content=["']Gatsby[ \d]/.test(near)) return true;
    from = at + 1;
  }
  return false;
}

const unquote = (src: string, open: number, max: number): string | undefined => {
  const quote = src[open];
  for (let j = open + 1; j < Math.min(src.length, open + max); j += 1) {
    if (src[j] === "\\") j += 1;
    else if (src[j] === quote) return src.slice(open, j + 1);
  }
  return undefined;
};

/** The page's own path from `window.pagePath="/about/"`, or undefined. */
function readPagePath(body: string): string | undefined {
  const at = body.indexOf("window.pagePath=");
  if (at < 0) return undefined;
  const literal = unquote(body, at + "window.pagePath=".length, 600);
  if (literal === undefined || literal[0] !== '"') return undefined;
  try {
    const v: unknown = JSON.parse(literal);
    return typeof v === "string" && v.startsWith("/") ? v : undefined;
  } catch {
    return undefined;
  }
}

const strip = (s: string): string => s.replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * The address of this page's own data, as Gatsby's client builds it: `/page-data/<path>/page-data.json`
 * (`index` for the home page), after any path prefix. The prefix is whatever comes before
 * `window.pagePath` in the page's address. No query, no fragment.
 */
export function pageDataAddress(page: PageSnapshot): string {
  const u = new URL(page.finalUrl);
  const route = strip(u.pathname);
  const own = readPagePath(bodyOf(page));
  let prefix = "";
  let path = route;
  if (own !== undefined) {
    const p = strip(own);
    const here = `/${route}`;
    if (p === "") prefix = route === "" ? "" : `/${route}`;
    else if (here.endsWith(`/${p}`)) prefix = here.slice(0, here.length - p.length - 1);
    if (p === "" || here.endsWith(`/${p}`)) path = p;
  }
  return `${u.origin}${prefix}/page-data/${path === "" ? "index" : path}/page-data.json`;
}

const HASH = /^[A-Za-z0-9]{1,40}$/;

/** The address of a static query's result, beside the page's own data. */
export function staticQueryAddress(pageDataUrl: string, hash: string): string {
  const at = pageDataUrl.indexOf("/page-data/");
  return `${pageDataUrl.slice(0, at)}/page-data/sq/d/${hash}.json`;
}

/** An address Gatsby serves its data at: a page's, `app-data.json` or a static query's. */
export function isPageDataAddress(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    const at = p.indexOf("/page-data/");
    if (at < 0) return false;
    const rest = p.slice(at + "/page-data/".length);
    if (rest === "app-data.json") return true;
    if (rest.startsWith("sq/d/")) return rest.endsWith(".json") && rest.length > 10;
    return rest.endsWith("/page-data.json") && rest.length > "/page-data.json".length;
  } catch {
    return false;
  }
}

/** One leaf of a payload: a dotted path, its kind, and for a string the value (kept in memory, never shown). */
export interface Field {
  path: string;
  kind: "string" | "number" | "boolean" | "null" | "other";
  value?: string | number | boolean;
}
export type DataRead = { fields: Field[]; hashes: string[] } | { unread: string };

/**
 * Walk a parsed value for its leaves, to depth 8, with a visit cap and a field cap, so a hostile
 * payload ends in a short list, never a hang. Names are only ever used as strings in a list, never
 * as keys of a plain object, so a `__proto__` or `constructor` key is just a name.
 */
function leaves(root: unknown, prefix: string, out: Field[], budget: { visits: number }): void {
  const walk = (v: unknown, path: string, depth: number): void => {
    if (budget.visits++ > VISITS_MAX || out.length >= FIELDS_MAX) return;
    const leaf = (kind: Field["kind"], value?: Field["value"]): void => {
      out.push({ path, kind, ...(value !== undefined ? { value } : {}) });
    };
    if (v === null) return leaf("null");
    if (typeof v === "string") return leaf("string", v);
    if (typeof v === "number") return leaf("number", v);
    if (typeof v === "boolean") return leaf("boolean", v);
    if (depth >= DEPTH_MAX) return leaf("other");
    if (Array.isArray(v)) v.slice(0, 50).forEach((c) => walk(c, `${path}[]`, depth + 1));
    else if (v && typeof v === "object")
      for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`, depth + 1);
  };
  walk(root, prefix, 0);
}

const parse = (text: string, truncated: boolean): unknown => {
  if (truncated || text.length > DATA_MAX) return "big";
  try {
    return JSON.parse(text);
  } catch {
    return "bad";
  }
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A page-data body read for its field paths and kinds, and its static query hashes. */
export function readPageData(text: string, truncated = false): DataRead {
  const doc = parse(text, truncated);
  if (doc === "big" && (truncated || text.length > DATA_MAX))
    return { unread: "the data answer is larger than is read" };
  const result = isObject(doc) ? doc.result : undefined;
  if (!isObject(result)) return { unread: "the data answer is not a Gatsby page-data payload" };
  const fields: Field[] = [];
  const budget = { visits: 0 };
  leaves(result.data, "data", fields, budget);
  leaves(result.pageContext, "pageContext", fields, budget);
  const raw = (doc as Record<string, unknown>).staticQueryHashes;
  const hashes = [
    ...new Set(
      (Array.isArray(raw) ? raw : [])
        .filter((h): h is string => typeof h === "string" && HASH.test(h))
        .slice(0, QUERIES_MAX),
    ),
  ];
  return { fields, hashes };
}

/** A static query's body (`{"data": ...}`) read for its field paths and kinds. */
export function readStaticQuery(text: string, truncated = false): DataRead {
  const doc = parse(text, truncated);
  if (doc === "big" && (truncated || text.length > DATA_MAX))
    return { unread: "the data answer is larger than is read" };
  if (!isObject(doc) || !("data" in doc))
    return { unread: "the data answer is not a Gatsby static query result" };
  const fields: Field[] = [];
  leaves(doc.data, "data", fields, { visits: 0 });
  return { fields, hashes: [] };
}

/** From an opening brace to its match, skipping strings; undefined when it does not close within `max`. */
function balanced(src: string, open: number, max: number): string | undefined {
  const stop = Math.min(src.length, open + max);
  let depth = 0;
  for (let i = open; i < stop; i += 1) {
    const c = src[i];
    if (c === '"') {
      for (i += 1; i < stop && src[i] !== '"'; i += 1) if (src[i] === "\\") i += 1;
      if (i >= stop) return undefined;
    } else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

/**
 * The page data Gatsby inlines as `window.pageData={...}` (a JSON literal, cache-dir/static-entry.js),
 * when the page has it. Undefined when it does not.
 */
export function embeddedPageData(page: PageSnapshot): DataRead | undefined {
  const body = bodyOf(page);
  const at = body.indexOf("window.pageData=");
  if (at < 0) return undefined;
  let open = at + "window.pageData=".length;
  while (open < body.length && /\s/.test(body[open] ?? "")) open += 1;
  if (body[open] !== "{") return undefined;
  const literal = balanced(body, open, DATA_MAX);
  if (literal === undefined)
    return {
      unread:
        body.indexOf("</script", open) < 0 && isTruncated(page)
          ? "the page was cut before its embedded page data ended"
          : "the embedded page data is not closed within the amount read",
    };
  return readPageData(literal);
}

/** The files only `gatsby develop` serves, named by the page's scripts. In a fixed order. */
const DEV_FILES = ["/socket.io/socket.io.js", "/commons.js", "/framework.js"] as const;

export function devMarkers(page: PageSnapshot): string[] {
  const paths = page.scripts.map((s) => {
    try {
      return new URL(s.slice(0, 500), page.finalUrl).pathname;
    } catch {
      return "";
    }
  });
  return DEV_FILES.filter((m) => paths.some((p) => p.endsWith(m)));
}

/** The GraphiQL page `gatsby develop` serves at /___graphql: its title is `Gatsby - GraphiQL`. */
export function isGraphiqlPage(body: string): boolean {
  const head = body.slice(0, 5_000);
  const open = head.indexOf("<title>");
  const close = open < 0 ? -1 : head.indexOf("</title>", open);
  return close > open && close - open <= 100 && /graphiql/i.test(head.slice(open, close));
}

const PRIVATE_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "private",
  "credential",
  "credentials",
  "ssn",
  "salt",
  "bearer",
  "authorization",
  "cvv",
  "iban",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "internalnote",
  "internalnotes",
]);

/** The names that say, by their words, that they hold something private. Names in, names out. */
export function privateNames(names: readonly string[]): string[] {
  return names.filter((n) => {
    const words = n
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w !== "");
    if (words.some((w) => PRIVATE_WORDS.has(w))) return true;
    return words.some((w, i) => i > 0 && PRIVATE_WORDS.has(`${words[i - 1]}${w}`));
  });
}

/** The last name in a field path, without its array marker. */
export const leafName = (path: string): string => {
  const at = path.lastIndexOf(".");
  return (at < 0 ? path : path.slice(at + 1)).replace(/\[\]$/, "");
};
