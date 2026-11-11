import type { PageSnapshot } from "../snapshot.js";

/**
 * Reading an Angular SSR or Analog page, from its HTML as sent. Every function here is pure and
 * linear in the size of the input, which is capped: a hostile page cannot make a check slow. A body
 * cut at the fetcher's limit is reported as unread, never as clean. Markers come from the installed
 * @angular/core, @angular/platform-server, @angular/common and @analogjs/router packages.
 */

/** The most HTML one check reads. */
export const MAX_SCAN_CHARS = 2_000_000;
/** The most one transfer-state script is parsed. */
export const MAX_STATE_CHARS = 500_000;
export const MAX_STATE_SCRIPTS = 5;
const MAX_FIELDS = 500;
const MAX_DEPTH = 8;
const MAX_NAME = 40;

export interface PageBody {
  /** The HTML to scan, cut at MAX_SCAN_CHARS. */
  html: string;
  /** The body was cut by the fetcher or by MAX_SCAN_CHARS: what is not in `html` was not read. */
  unread: boolean;
}

export function pageBody(page: PageSnapshot): PageBody {
  const hop = page.hops.at(-1);
  const body = hop?.body ?? "";
  return {
    html: body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body,
    unread: hop?.truncated === true || body.length > MAX_SCAN_CHARS,
  };
}

const VERSION_ATTR = /\sng-version=["'][^"']{1,40}["']/;
const CONTEXT_ATTR = /\sng-server-context=["']([A-Za-z0-9|-]{1,40})["']/;
const STATE_ID = /\sid=["']([A-Za-z0-9_-]{1,40}-state)["']/;

/**
 * An Angular site rendered on the server, from its HTML: the root element's ng-version or
 * ng-server-context attribute (set by the renderer), or the transfer-state script, an
 * application/json script whose id is the app id plus "-state" (ng-state by default, serverApp-state
 * in older Universal apps).
 */
export function isAngularSite(page: PageSnapshot): boolean {
  const { html } = pageBody(page);
  return VERSION_ATTR.test(html) || CONTEXT_ATTR.test(html) || readStateScripts(html).found > 0;
}

/** The server context the renderer wrote: ssr, ssg, ssr-analog (the Analog template) or other. */
export function serverContext(html: string): string | undefined {
  return CONTEXT_ATTR.exec(html)?.[1];
}

/** What a production page must not carry: the dev server's client and Angular's component HMR endpoint. */
const DEV_MARKERS: readonly [string, string][] = [
  ['src="/@vite/client"', "the Vite dev client (/@vite/client)"],
  ["/@ng/component", "the dev server's component update address (/@ng/component)"],
  ["/@analogjs/", "an Analog dev module (/@analogjs/)"],
];

export function devMarkers(html: string): string[] {
  return DEV_MARKERS.filter(([needle]) => html.includes(needle)).map(([, label]) => label);
}

export type FieldKind = "string" | "number" | "boolean" | "null" | "other";
export interface StateField {
  /** The dotted path of the field, capped; never a value. */
  name: string;
  kind: FieldKind;
  isTrue: boolean;
}
export interface StateRead {
  /** Transfer-state scripts found. */
  found: number;
  /** Scripts that were too large or not JSON: what is in them was not read. */
  unread: number;
  fields: StateField[];
}

const safeName = (s: string): string => s.replace(/[^\w.$-]/g, "?").slice(0, MAX_NAME);

function kindOf(value: unknown): FieldKind {
  return value === null
    ? "null"
    : typeof value === "string"
      ? "string"
      : typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : "other";
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Keep each leaf's path and kind. Reads own keys only and assigns nothing, so a `__proto__` or
 * `constructor` key is just a name. An HttpClient transfer-cache entry ({ b, h, s, st, u, rt }) is
 * walked through its body `b` under the label http-cache[n]; its headers and URL are not read.
 */
function walk(node: unknown, path: string, out: StateField[], depth: number): void {
  if (out.length >= MAX_FIELDS || depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) walk(item, `${path}[]`, out, depth + 1);
    return;
  }
  if (isObject(node)) {
    for (const key of Object.keys(node).slice(0, 100))
      walk(node[key], path ? `${path}.${safeName(key)}` : safeName(key), out, depth + 1);
    return;
  }
  out.push({ name: path, kind: kindOf(node), isTrue: node === true });
}

const isCacheEntry = (v: unknown): v is Record<string, unknown> =>
  isObject(v) &&
  Object.hasOwn(v, "b") &&
  Object.hasOwn(v, "u") &&
  Object.hasOwn(v, "s") &&
  typeof v["u"] === "string";

/** The transfer-state scripts on the page, with the names and kinds of what they carry. */
export function readStateScripts(html: string): StateRead {
  const result: StateRead = { found: 0, unread: 0, fields: [] };
  let cache = 0;
  let from = 0;
  while (result.found < MAX_STATE_SCRIPTS) {
    const start = html.indexOf("<script", from);
    if (start < 0) break;
    from = start + 7;
    const head = html.slice(start, start + 501);
    const gt = head.indexOf(">");
    if (gt < 0) continue;
    const tagEnd = start + gt;
    const tag = head.slice(0, gt);
    if (!STATE_ID.test(tag) || !/type=["']application\/json["']/.test(tag)) continue;
    from = tagEnd + 1;
    result.found += 1;
    const close = html.indexOf("</script", tagEnd);
    if (close < 0 || close - tagEnd > MAX_STATE_CHARS) {
      result.unread += 1;
      continue;
    }
    try {
      const state: unknown = JSON.parse(html.slice(tagEnd + 1, close));
      if (!isObject(state)) {
        result.unread += 1;
        continue;
      }
      for (const key of Object.keys(state).slice(0, 200)) {
        const value = state[key];
        if (isCacheEntry(value)) {
          walk(value["b"], `http-cache[${cache}]`, result.fields, 1);
          cache += 1;
        } else walk(value, safeName(key), result.fields, 0);
      }
    } catch {
      result.unread += 1;
    }
    from = close;
  }
  return result;
}

/**
 * What a server-side render that failed leaves in a page: Angular's runtime error codes (NG0xxx, the
 * message format of formatRuntimeError), the injector errors, the "x is not defined" errors of code
 * that touches the browser on the server, and stack frames from node_modules/@angular.
 */
const ERROR_MARKERS: readonly [RegExp, string][] = [
  [/\bNG0\d{3,4}: [^<\n]{1,120}/, "an Angular error code (NG0...)"],
  [/\b(?:NullInjectorError|R3InjectorError)\b/, "an Angular injector error"],
  [
    /\bReferenceError: (?:window|document|localStorage|sessionStorage|navigator) is not defined/,
    "a ReferenceError from browser-only code run on the server",
  ],
  [/\n[ \t]{2,}at [^\n]{1,200}node_modules\/@angular\//, "a stack trace through @angular"],
];

/** The visible text of the page: everything outside script and style elements. Linear. */
export function visibleText(html: string): string {
  const parts: string[] = [];
  let from = 0;
  // Each next position is looked up again only once the scan has passed it: no quadratic rescans.
  let script = -2;
  let style = -2;
  while (from < html.length) {
    if (script !== -1 && script < from) script = html.indexOf("<script", from);
    if (style !== -1 && style < from) style = html.indexOf("<style", from);
    const next = script < 0 ? style : style < 0 ? script : Math.min(script, style);
    if (next < 0) {
      parts.push(html.slice(from));
      break;
    }
    parts.push(html.slice(from, next));
    const closer = next === script ? "</script" : "</style";
    const end = html.indexOf(closer, next);
    if (end < 0) break;
    const gt = html.slice(end, end + 20).indexOf(">");
    from = end + (gt < 0 ? closer.length : gt + 1);
  }
  return parts.join("");
}

export function errorMarkers(html: string): string[] {
  const text = visibleText(html);
  return ERROR_MARKERS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

const NAME = "[A-Za-z0-9_.-]{1,80}";
const uniq = (values: Iterable<string>, max = 20): string[] => [...new Set(values)].slice(0, max);

/** Analog server functions the page calls: /_analog/fn/<id>. */
export function analogFunctions(html: string): string[] {
  const re = new RegExp(`/_analog/fn/(${NAME})`, "g");
  return uniq([...html.matchAll(re)].map((m) => m[1] ?? ""));
}

/** Analog page and API addresses the page names: /api/_analog/pages/<path>. */
export function analogPageEndpoints(html: string): string[] {
  const re = /\/api\/_analog\/pages\/([A-Za-z0-9_./[\]-]{0,80})/g;
  return uniq([...html.matchAll(re)].map((m) => `/api/_analog/pages/${m[1] ?? ""}`));
}
