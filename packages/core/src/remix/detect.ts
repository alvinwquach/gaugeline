import type { PageSnapshot } from "../snapshot.js";

/**
 * Remix (v2) and React Router 7 framework mode, from what a page already says. Every marker here
 * was read from the installed packages (npm, 11 November 2026: react-router 7.18.5,
 * @react-router/dev 7.18.5, @remix-run/server-runtime, @remix-run/react and @remix-run/dev 2.17.5),
 * not remembered:
 *  - the document carries `window.__reactRouterContext = {...}` (React Router 7) or
 *    `window.__remixContext = {...}` (Remix v2): JSON for the basename, the future flags and, in
 *    Remix v2 without single fetch, `state.loaderData`; the same object is followed by
 *    `<context>.streamController.enqueue("<chunk>")` scripts when the loader data is streamed;
 *  - a streamed chunk is turbo-stream: a flat JSON array where an object is `{"_<i>": <j>}` (key
 *    `values[i]`, value `values[j]`) and an array that starts with a string is a typed value;
 *  - a React Router data router rendered on the server writes
 *    `window.__staticRouterHydrationData = JSON.parse("...")` (loaderData, actionData, errors);
 *  - data requests: `<path>.data` (single fetch, content type `text/x-script`) and `?_data=<routeId>`
 *    (Remix v2 data requests); both answer with the header `X-Remix-Response: yes`;
 *  - the dev server's modules: `/@id/__x00__virtual:react-router/inject-hmr-runtime` and
 *    `virtual:remix/inject-hmr-runtime`, `/@vite/client`, `/@react-refresh`, and the classic
 *    compiler's `remixLiveReloadConnect`.
 * Everything is a linear scan over a capped slice of the body: no backtracking patterns.
 */

/** The most characters of a page's HTML read. */
export const SCAN_MAX = 400_000;
/** The most characters of one embedded value (a context object, a stream chunk) read. */
export const STATE_MAX = 400_000;
/** The most distinct field names kept from one page. */
export const NAMES_MAX = 2_000;
const DEPTH_MAX = 12;
const VISITS_MAX = 30_000;
const CHUNKS_MAX = 24;

const bodyOf = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, SCAN_MAX);
const isTruncated = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CONTEXT_MARKERS = ["__reactRouterContext", "__remixContext", "__staticRouterHydrationData"];
const OTHER_MARKERS = [
  "__reactRouterManifest",
  "__remixManifest",
  "__reactRouterRouteModules",
  "__remixRouteModules",
];

/** The index just after `name` and ` =` when the body assigns it (`window.name = `), else -1. */
function assignmentAt(body: string, name: string, from: number): { at: number; after: number } {
  let search = from;
  for (let tries = 0; tries < 6; tries += 1) {
    const at = body.indexOf(name, search);
    if (at < 0) return { at: -1, after: -1 };
    search = at + name.length;
    const before = body[at - 1] ?? "";
    if (/[A-Za-z0-9_$]/.test(before)) continue;
    let i = search;
    while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
    if (body[i] !== "=" || body[i + 1] === "=") continue;
    i += 1;
    while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
    return { at, after: i };
  }
  return { at: -1, after: -1 };
}

/** A Remix v2 or React Router 7 site, from its headers or the markers its own scripts write. */
export function isRemixSite(page: PageSnapshot): boolean {
  const headers = page.hops.at(-1)?.headers ?? {};
  if (headers["x-remix-response"] !== undefined) return true;
  const body = bodyOf(page);
  for (const m of [...CONTEXT_MARKERS, ...OTHER_MARKERS])
    if (assignmentAt(body, m, 0).at >= 0) return true;
  return false;
}

/** The index of the quote that closes the string opened at `i` (or `stop` when it does not). */
function endOfString(src: string, i: number, stop: number): number {
  for (let j = i + 1; j < stop; j += 1) {
    if (src[j] === "\\") j += 1;
    else if (src[j] === '"') return j;
  }
  return stop;
}

/** From an opening bracket to its match, skipping JSON strings; undefined when it does not close within `max`. */
function balanced(src: string, open: number, max: number): string | undefined {
  const stop = Math.min(src.length, open + max);
  let depth = 0;
  for (let i = open; i < stop; i += 1) {
    const c = src[i];
    if (c === '"') {
      i = endOfString(src, i, stop);
      if (i >= stop) return undefined;
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

/** Every object key of a parsed JSON value, once each. Iterative, depth and visit capped. */
function jsonNames(root: unknown, into: Set<string>): void {
  const stack: [unknown, number][] = [[root, 0]];
  let visits = 0;
  while (stack.length > 0 && visits++ < VISITS_MAX && into.size < NAMES_MAX) {
    const [v, depth] = stack.pop() as [unknown, number];
    if (depth >= DEPTH_MAX) continue;
    if (Array.isArray(v)) for (const c of v.slice(0, 200)) stack.push([c, depth + 1]);
    else if (isRecord(v))
      for (const [k, child] of Object.entries(v)) {
        if (k.length <= 80) into.add(k);
        stack.push([child, depth + 1]);
      }
  }
}

/**
 * Property names in a turbo-stream chunk's first line (a flat JSON array): an object is
 * `{"_<i>": <j>}` and the name is `values[i]`. Walks from index 0 once per index, so a cycle ends.
 * Returns false when the line is not that format.
 */
export function turboNames(line: string, into: Set<string>): boolean {
  if (line.length > STATE_MAX || !line.startsWith("[")) return false;
  let values: unknown;
  try {
    values = JSON.parse(line);
  } catch {
    return false;
  }
  if (!Array.isArray(values) || values.length === 0) return false;
  const seen = new Set<number>();
  const stack: number[] = [0];
  let visits = 0;
  const pushObject = (o: Record<string, unknown>): void => {
    for (const [k, child] of Object.entries(o)) {
      if (k.startsWith("_")) {
        const name: unknown = values[Number(k.slice(1))];
        if (typeof name === "string" && name.length <= 80) into.add(name);
      }
      if (typeof child === "number") stack.push(child);
    }
  };
  while (stack.length > 0 && visits++ < VISITS_MAX && into.size < NAMES_MAX) {
    const i = stack.pop() as number;
    if (!Number.isInteger(i) || i < 0 || i >= values.length || seen.has(i)) continue;
    seen.add(i);
    const v: unknown = values[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        // A typed value; a null-prototype object ("N") holds an object after its tag.
        if (v[0] === "N" && isRecord(v[1])) pushObject(v[1]);
      } else for (const c of v.slice(0, 500)) if (typeof c === "number") stack.push(c);
    } else if (isRecord(v)) pushObject(v);
  }
  return true;
}

export interface Embedded {
  /** The global the page assigns: `__reactRouterContext`, `__remixContext` or `__staticRouterHydrationData`. */
  marker: string;
  /** Field names found in the context and in its first stream chunk, once each. Names only. */
  names: string[];
  /** Stream chunks after the first (deferred values) are not read: the state may hold more. */
  deferred: boolean;
  /** Why the state could not be read, when it could not. */
  unread?: string;
}

/** The first context a page embeds, as field names. Never throws; never returns a value. */
export function readEmbedded(page: PageSnapshot): Embedded | undefined {
  const body = bodyOf(page);
  const cut = isTruncated(page);
  for (const marker of CONTEXT_MARKERS) {
    const { at, after } = assignmentAt(body, marker, 0);
    if (at < 0) continue;
    const out: Embedded = { marker, names: [], deferred: false };
    const names = new Set<string>();
    const fail = (why: string): Embedded => ({ ...out, unread: why });
    if (marker === "__staticRouterHydrationData") {
      if (!body.startsWith("JSON.parse(", after))
        return fail("the hydration data is not JSON.parse");
      const open = after + "JSON.parse(".length;
      if (body[open] !== '"') return fail("the hydration data is not a string literal");
      const end = endOfString(body, open, Math.min(body.length, open + STATE_MAX));
      if (body[end] !== '"')
        return fail(
          cut
            ? "the page was cut before its embedded state ended"
            : `the embedded state is not closed within ${STATE_MAX} characters`,
        );
      try {
        jsonNames(JSON.parse(JSON.parse(body.slice(open, end + 1)) as string), names);
      } catch {
        return fail("the embedded state is not JSON this reader understands");
      }
      return { ...out, names: [...names] };
    }
    if (body[after] !== "{") return fail("the embedded context is not an object literal");
    const literal = balanced(body, after, STATE_MAX);
    if (literal === undefined)
      return fail(
        cut
          ? "the page was cut before its embedded state ended"
          : `the embedded state is not closed within ${STATE_MAX} characters`,
      );
    try {
      jsonNames(JSON.parse(literal), names);
    } catch {
      return fail("the embedded state is not JSON this reader understands");
    }
    // The streamed loader data: <marker>.streamController.enqueue("<turbo-stream chunk>").
    const call = `${marker}.streamController.enqueue(`;
    let from = after + literal.length;
    let chunks = 0;
    let first = true;
    for (; chunks < CHUNKS_MAX; chunks += 1) {
      const c = body.indexOf(call, from);
      if (c < 0) break;
      const open = c + call.length;
      from = open;
      if (body[open] !== '"') continue;
      const end = endOfString(body, open, Math.min(body.length, open + STATE_MAX));
      if (body[end] !== '"')
        return { ...out, names: [...names], unread: "a streamed chunk was cut or is too large" };
      let text: string;
      try {
        text = JSON.parse(body.slice(open, end + 1)) as string;
      } catch {
        return { ...out, names: [...names], unread: "a streamed chunk is not a JSON string" };
      }
      if (first) {
        first = false;
        const line = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"));
        if (!turboNames(line, names))
          return { ...out, names: [...names], unread: "the streamed state is not turbo-stream" };
      } else out.deferred = true;
    }
    return { ...out, names: [...names] };
  }
  return undefined;
}

/** Markers only a development server writes. Each is a name the dev tooling uses. */
export function devMarkers(page: PageSnapshot): string[] {
  const body = bodyOf(page);
  const out: string[] = [];
  const has = (needle: string): boolean =>
    page.scripts.some((s) => s.includes(needle)) || body.includes(needle);
  for (const m of [
    "/@vite/client",
    "/@react-refresh",
    "inject-hmr-runtime",
    "remixLiveReloadConnect",
    "__vite_plugin_react_preamble_installed__",
    "/node_modules/.vite/",
  ])
    if (has(m)) out.push(m);
  return out;
}

/** True for `<path>.data` (single fetch) and `?_data=` (Remix v2 data request) addresses. */
export function isDataAddress(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.endsWith(".data") || u.searchParams.has("_data");
  } catch {
    return false;
  }
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
