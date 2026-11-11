import type { PageSnapshot } from "../snapshot.js";

/**
 * SvelteKit, from what a page already says. Every address and marker here is read from the
 * @sveltejs/kit source (npm, 3.2.0) and its docs on GitHub, not remembered:
 *  - the page response carries `x-sveltekit-page: true` (runtime/server/page/render.js);
 *  - the page's inline bootstrap script assigns `__sveltekit_<hash> = { base, version, ... }`, and
 *    then calls start(element, { node_ids: [...], data: [...], form, error }) (render.js); under
 *    `vite dev` the global is `__sveltekit_dev` (core/utils.js get_global_name);
 *  - route data is served at `<page>/__data.json` (`<page>.html__data.json` for a `.html` page)
 *    (pathname.js), as JSON, or as `text/sveltekit-data` when the page streams (data/index.js);
 *  - the build writes `<appDir>/version.json` as `{"version": "<kit.version.name>"}` (default
 *    appDir `_app`), and the bootstrap script holds the same name as `version`.
 * Everything is a linear scan over a capped slice of the body: no backtracking patterns.
 */

/** The most characters of a page's HTML read for the bootstrap script. */
export const SCAN_MAX = 400_000;
/** The most characters of the embedded state read. */
export const STATE_MAX = 200_000;
/** The most characters of a `__data.json` read. */
export const DATA_MAX = 1_000_000;
/** The most distinct field names and fields kept from one payload. */
export const NAMES_MAX = 2_000;
const DEPTH_MAX = 6;
const NODE_VISITS_MAX = 20_000;

const bodyOf = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, SCAN_MAX);
const isTruncated = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;
const identChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

export interface Bootstrap {
  /** `__sveltekit_<hash>`, or `__sveltekit_dev` under the dev server. */
  global: string;
  dev: boolean;
  /** kit.version.name as the page was built with it. */
  version?: string;
  /** The `data: [...]` literal handed to the client, when it was found whole. */
  state?: string;
  /** Why the state could not be read, when it could not. */
  stateUnread?: string;
}

/** The first `__sveltekit_x = {` assignment in the page and the state literal after it. */
export function readBootstrap(page: PageSnapshot): Bootstrap | undefined {
  const body = bodyOf(page);
  let from = 0;
  for (let tries = 0; tries < 5; tries += 1) {
    const at = body.indexOf("__sveltekit_", from);
    if (at < 0) return undefined;
    let end = at;
    while (end < body.length && identChar(body[end] ?? "")) end += 1;
    from = end;
    let eq = end;
    while (eq < body.length && /\s/.test(body[eq] ?? "")) eq += 1;
    if (body[eq] !== "=" || body[eq + 1] === "=") continue;
    const global = body.slice(at, end);
    const scriptEnd = body.indexOf("</script", eq);
    const script = body.slice(eq, scriptEnd < 0 ? body.length : scriptEnd);
    const out: Bootstrap = { global, dev: global === "__sveltekit_dev" };
    const v = script.indexOf("version:");
    if (v >= 0 && v < 600) {
      const q = script.indexOf('"', v);
      const close = q < 0 ? -1 : script.indexOf('"', q + 1);
      if (q >= 0 && close > q && close - q <= 200) out.version = script.slice(q + 1, close);
    }
    const ids = script.indexOf("node_ids:");
    const data = ids < 0 ? -1 : script.indexOf("data:", ids);
    if (data >= 0) {
      let open = data + 5;
      while (open < script.length && /\s/.test(script[open] ?? "")) open += 1;
      if (script[open] === "[") {
        const literal = balanced(script, open, STATE_MAX);
        if (literal !== undefined) out.state = literal;
        else
          out.stateUnread =
            scriptEnd < 0 && isTruncated(page)
              ? "the page was cut before its embedded state ended"
              : `the embedded state is not closed within ${STATE_MAX} characters`;
      }
    }
    return out;
  }
  return undefined;
}

/** From an opening bracket to its match, skipping strings; undefined when it does not close within `max`. */
function balanced(src: string, open: number, max: number): string | undefined {
  const stop = Math.min(src.length, open + max);
  let depth = 0;
  for (let i = open; i < stop; i += 1) {
    const c = src[i] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      i = endOfString(src, i, stop);
      if (i >= stop) return undefined;
    } else if (c === "[" || c === "{" || c === "(") depth += 1;
    else if (c === "]" || c === "}" || c === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

/** The index of the quote that closes the string opened at `i` (or `stop` when it does not). */
function endOfString(src: string, i: number, stop: number): number {
  const quote = src[i];
  for (let j = i + 1; j < stop; j += 1) {
    if (src[j] === "\\") j += 1;
    else if (src[j] === quote) return j;
  }
  return stop;
}

/**
 * A SvelteKit site, from its responses: the x-sveltekit-page header, or, behind a proxy that
 * strips it, a bootstrap script, data-sveltekit-* attributes or modules under <appDir>/immutable.
 */
export function isSveltekitSite(page: PageSnapshot): boolean {
  const headers = page.hops.at(-1)?.headers ?? {};
  if ((headers["x-sveltekit-page"] ?? "").toLowerCase() === "true") return true;
  if (headers["x-sveltekit-version"] !== undefined) return true;
  if (readBootstrap(page) !== undefined) return true;
  if (page.scripts.some((s) => /\/immutable\/(?:entry|nodes|chunks)\//.test(s))) return true;
  return bodyOf(page).includes("data-sveltekit-");
}

/**
 * The address the page's own modules live under, up to and including the app directory (`_app`
 * unless kit.appDir says otherwise, after any kit.paths.base): `https://shop.example/_app`.
 * Undefined when the page names no module of its own.
 */
export function appPrefix(page: PageSnapshot): string | undefined {
  const marker = /\/immutable\/(?:entry|nodes|chunks)\//;
  const fromScripts = page.scripts.map((s) => s.slice(0, 500));
  // The modules are named in modulepreload links and the bootstrap's import(): look in the HTML too.
  const body = bodyOf(page);
  const at = body.indexOf("/immutable/entry/");
  if (at >= 0) {
    let start = at;
    while (start > 0 && at - start < 300 && !/["'(\s=]/.test(body[start - 1] ?? "")) start -= 1;
    fromScripts.push(body.slice(start, at + "/immutable/entry/".length));
  }
  for (const s of fromScripts) {
    const m = marker.exec(s);
    if (!m) continue;
    try {
      return new URL(s.slice(0, m.index), page.finalUrl).href.replace(/\/$/, "");
    } catch {
      // not an address
    }
  }
  return undefined;
}

/** The address route data is served at: `<page>/__data.json`, or `<page>.html__data.json`. No query. */
export function dataAddress(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.endsWith(".html")
    ? u.pathname.replace(/\.html$/, ".html__data.json")
    : `${u.pathname.replace(/\/$/, "")}/__data.json`;
  return u.href;
}

/** Why this page is a development server's, if it is. Each is a marker the dev server writes. */
export function devMarkers(page: PageSnapshot): string[] {
  const body = bodyOf(page);
  const out: string[] = [];
  if (readBootstrap(page)?.dev) out.push("__sveltekit_dev");
  // Vite's own paths are every Vite framework's, so they count only on a page that is SvelteKit's.
  const svelte = isSveltekitSite(page);
  for (const m of ["/@vite/client", "/.svelte-kit/", "/node_modules/.vite/"]) {
    if (m !== "/.svelte-kit/" && !svelte) continue;
    if (page.scripts.some((s) => s.includes(m)) || body.includes(m)) out.push(m);
  }
  return out;
}

/**
 * Property names in a JavaScript literal (what SvelteKit's uneval writes for the page's state),
 * names only, once each, in first-seen order. Strings are skipped, so a value that looks like
 * `password: x` is not a name. Linear; at most NAMES_MAX names.
 */
export function literalKeys(src: string): string[] {
  const seen = new Set<string>();
  let prev = "";
  for (let i = 0; i < src.length && seen.size < NAMES_MAX; i += 1) {
    const c = src[i] ?? "";
    if (/\s/.test(c)) continue;
    let name: string | undefined;
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(src, i, src.length);
      if (c !== "`") name = src.slice(i + 1, end);
      i = end;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && identChar(src[j] ?? "")) j += 1;
      name = src.slice(i, j);
      i = j - 1;
    } else {
      prev = c;
      continue;
    }
    let k = i + 1;
    while (k < src.length && /\s/.test(src[k] ?? "")) k += 1;
    if (name !== undefined && src[k] === ":" && (prev === "{" || prev === ",") && name.length <= 80)
      seen.add(name);
    prev = "x";
  }
  return [...seen];
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

/** One leaf of a node's data: a dotted path, its kind, and for a string, number or boolean, the value (kept in memory, never shown). */
export interface Field {
  path: string;
  kind: "string" | "number" | "boolean" | "null" | "other";
  value?: string | number | boolean;
}
export type DataRead = { nodes: Field[][] } | { unread: string };

const isIndex = (v: unknown, len: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < len;

/**
 * Read a `__data.json` body for its field names and kinds. The nodes hold devalue's flat arrays
 * (index 0 is the root, objects map names to indexes, a special value is an array that starts with
 * a type name); only the structure is walked, to depth 6, with a visit cap, so a cyclic or hostile
 * payload ends in "unread" or a short list, never a hang. A streamed answer (`text/sveltekit-data`)
 * is its first line. Names are only ever used as strings, never as keys of a plain object.
 */
export function readDataJson(text: string, contentType: string, truncated = false): DataRead {
  if (truncated || text.length > DATA_MAX)
    return { unread: "the data answer is larger than is read" };
  const first = /sveltekit-data/i.test(contentType)
    ? text.slice(0, text.indexOf("\n") + 1 || undefined)
    : text;
  let doc: unknown;
  try {
    doc = JSON.parse(first);
  } catch {
    return { unread: "the data answer is not JSON this reader understands" };
  }
  const nodes = (doc as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes) || (doc as { type?: unknown }).type !== "data")
    return { unread: "the data answer is not a SvelteKit data payload" };
  const out: Field[][] = [];
  let visits = 0;
  for (const node of nodes) {
    const fields: Field[] = [];
    out.push(fields);
    const arr = (node as { type?: unknown; data?: unknown } | null)?.data;
    if ((node as { type?: unknown } | null)?.type !== "data" || !Array.isArray(arr)) continue;
    const walk = (index: unknown, path: string, depth: number, trail: Set<number>): void => {
      if (!isIndex(index, arr.length) || visits++ > NODE_VISITS_MAX || fields.length >= NAMES_MAX)
        return;
      const v: unknown = arr[index];
      const leaf = (kind: Field["kind"], value?: Field["value"]): void => {
        fields.push({ path, kind, ...(value !== undefined ? { value } : {}) });
      };
      if (v === null) return leaf("null");
      if (typeof v === "string") return leaf("string", v);
      if (typeof v === "number") return leaf("number", v);
      if (typeof v === "boolean") return leaf("boolean", v);
      if (Array.isArray(v) && typeof v[0] === "string") return leaf("other");
      if (depth >= DEPTH_MAX || trail.has(index)) return leaf("other");
      const next = new Set(trail).add(index);
      if (Array.isArray(v)) {
        v.slice(0, 50).forEach((child) => walk(child, `${path}[]`, depth + 1, next));
      } else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v))
          walk(child, path === "" ? k : `${path}.${k}`, depth + 1, next);
      }
    };
    walk(0, "", 0, new Set());
  }
  return { nodes: out };
}
