import type { PageSnapshot } from "../snapshot.js";

/**
 * Reading an Astro page, from its HTML as sent. Every function here is pure and linear in the size
 * of the input, which is capped: a hostile page cannot make a check slow. A body cut at the fetcher's
 * limit is reported as unread, never as clean.
 */

/** The most HTML one check reads. */
export const MAX_SCAN_CHARS = 2_000_000;
/** The most one island's props attribute is decoded and parsed. */
export const MAX_PROPS_CHARS = 200_000;
export const MAX_ISLANDS = 100;
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

/**
 * An Astro site, from its HTML: an astro-island element, a data-astro-cid-* scoped-style attribute,
 * a meta generator of "Astro vX" (the template's `Astro.generator`), a script or stylesheet under
 * /_astro/ (the default build.assets directory), or a server-island script.
 */
export function isAstroSite(page: PageSnapshot): boolean {
  if (page.scripts.some((s) => /(?:^|\/)_astro\//.test(s))) return true;
  const { html } = pageBody(page);
  return (
    html.includes("<astro-island") ||
    html.includes("data-astro-cid-") ||
    /<meta[^>]{0,200}name=["']generator["'][^>]{0,200}content=["']Astro v/i.test(html) ||
    /(?:src|href)=["'][^"']{0,300}\/_astro\//.test(html) ||
    html.includes("/_server-islands/")
  );
}

/** What a production page must not carry: the dev server's client and the dev toolbar. */
const DEV_MARKERS: readonly [string, string][] = [
  ['src="/@vite/client"', "the Vite dev client (/@vite/client)"],
  ["/@id/astro/runtime/client/dev-toolbar/entrypoint.js", "the Astro dev toolbar script"],
  ["<astro-dev-toolbar", "the dev toolbar element"],
  ["data-astro-source-file=", "data-astro-source-file attributes"],
];

export function devMarkers(html: string): string[] {
  return DEV_MARKERS.filter(([needle]) => html.includes(needle)).map(([, label]) => label);
}

const NAME = "[A-Za-z0-9_.-]{1,80}";
const uniq = (values: Iterable<string>, max = 20): string[] => [...new Set(values)].slice(0, max);

/** Astro Actions the page calls: /_actions/<name> in its scripts or ?_action=<name> in a form. */
export function actionNames(html: string): string[] {
  const re = new RegExp(`/_actions/(${NAME})|[?&]_action=(${NAME})`, "g");
  return uniq(
    [...html.matchAll(re)].map((m) => (m[1] ?? m[2] ?? "").replace(/\.+$/, "")).filter(Boolean),
  );
}

/** Server islands the page loads: /_server-islands/<name>. */
export function serverIslandNames(html: string): string[] {
  const re = new RegExp(`/_server-islands/(${NAME})`, "g");
  return uniq([...html.matchAll(re)].map((m) => m[1] ?? ""));
}

export interface IslandField {
  /** The dotted path of the field, capped; never a value. */
  name: string;
  kind: "string" | "number" | "boolean" | "null" | "other";
  /** For a boolean only: it is true. */
  isTrue: boolean;
}
export interface Island {
  component: string;
  fields: IslandField[];
}

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" };
const decode = (s: string): string =>
  s.replace(/&(quot|amp|lt|gt|#39);/g, (_, e: string) => ENTITIES[e] ?? "");
const safeName = (s: string): string => s.replace(/[^\w.$-]/g, "?").slice(0, MAX_NAME);

/**
 * Astro serialises a client island's props as `{ name: [type, value] }` (type 0 a plain value, 1 an
 * array of such pairs). Walk that and keep each leaf's name and kind. The walk reads own keys only and
 * assigns nothing, so a `__proto__` key is just a name.
 */
function walk(node: unknown, path: string, out: IslandField[], depth: number): void {
  if (out.length >= MAX_FIELDS || depth > MAX_DEPTH) return;
  if (!Array.isArray(node) || node.length !== 2 || typeof node[0] !== "number") return;
  const [type, value] = node as [number, unknown];
  if (type === 1 && Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walk(item, path, out, depth + 1);
    return;
  }
  if (type === 0 && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value).slice(0, 100))
      walk(
        (value as Record<string, unknown>)[key],
        path ? `${path}.${safeName(key)}` : safeName(key),
        out,
        depth + 1,
      );
    return;
  }
  const kind =
    value === null
      ? "null"
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? typeof value
        : "other";
  out.push({ name: path, kind, isTrue: value === true });
}

/** The client islands on the page (the astro-island elements) and the names of their props. */
export function readIslands(html: string): { islands: Island[]; unreadIslands: number } {
  const islands: Island[] = [];
  let unreadIslands = 0;
  let from = 0;
  while (islands.length + unreadIslands < MAX_ISLANDS) {
    const start = html.indexOf("<astro-island", from);
    if (start < 0) break;
    const end = html.indexOf(">", start);
    from = start + 13;
    if (end < 0) {
      unreadIslands += 1;
      break;
    }
    if (end - start > MAX_PROPS_CHARS + 2000) {
      unreadIslands += 1;
      continue;
    }
    const tag = html.slice(start, end);
    const raw = /\sprops="([^"]*)"/.exec(tag)?.[1];
    if (raw === undefined) continue;
    const component =
      /\scomponent-url="[^"]{0,300}?([A-Za-z0-9_-]{1,60})(?:\.[A-Za-z0-9_-]{4,12})?\.js"/.exec(
        tag,
      )?.[1] ?? "unknown";
    if (raw.length > MAX_PROPS_CHARS) {
      unreadIslands += 1;
      continue;
    }
    try {
      const fields: IslandField[] = [];
      const props: unknown = JSON.parse(decode(raw));
      if (props !== null && typeof props === "object" && !Array.isArray(props))
        for (const key of Object.keys(props).slice(0, 100))
          walk((props as Record<string, unknown>)[key], safeName(key), fields, 0);
      islands.push({ component: safeName(component), fields });
    } catch {
      unreadIslands += 1;
    }
  }
  return { islands, unreadIslands };
}
