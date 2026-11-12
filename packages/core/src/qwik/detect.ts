import type { PageSnapshot } from "../snapshot.js";

/**
 * Qwik and Qwik City, from what a page already says. Every address and marker is read from the
 * @builder.io/qwik 1.20.4 and @builder.io/qwik-city 1.20.4 package source (npm), not remembered
 * (docs unreachable from the build host: [docs: package source]):
 *  - the container element carries `q:container`, `q:version`, `q:render` ("ssr", or "ssr-dev" under
 *    the dev server) and `q:manifest-hash` ("dev<hash>" without a build) (qwik server.mjs, core.mjs);
 *  - the serialized state is `<script type="qwik/json">` holding JSON `{refs, ctx, objs, subs}`, with
 *    `<` written as `\x3C` (server.mjs escapeText);
 *  - Qwik City answers `<route>/q-data.json` with `{"_entry": id, "_objs": [...]}`: the loaders'
 *    data, action, status, href (request-handler `renderQData`, `makeQDataPath`);
 *  - a `server$` call is a POST to `<route>?qfunc=<hash>` (request-handler `runServerFunction`); a `routeAction$` form posts to `<route>?qaction=<id>`.
 * Qwik 2 (`@qwik.dev/*`) writes a different state format: not read here (uncited), so its state is
 * reported as could not check. Everything is a linear scan over a capped slice of the body.
 */

export const SCAN_MAX = 400_000;
export const STATE_MAX = 300_000;
export const DATA_MAX = 1_000_000;
export const NAMES_MAX = 2_000;
const OBJS_MAX = 20_000;

const bodyOf = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, SCAN_MAX);
const isTruncated = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;

/** The inside of the first `<script type="qwik/json">`, or why there is none to read. */
function stateScript(page: PageSnapshot): { text: string } | { unread: string } | undefined {
  const body = bodyOf(page);
  let from = 0;
  for (let tries = 0; tries < 8; tries += 1) {
    const at = body.indexOf("qwik/json", from);
    if (at < 0) return undefined;
    from = at + 9;
    const before = body.slice(Math.max(0, at - 8), at).toLowerCase();
    if (!/type=["']?$/.test(before)) continue;
    const open = body.indexOf(">", at);
    if (open < 0 || open - at > 80) continue;
    const close = body.indexOf("</script", open);
    if (close < 0)
      return {
        unread: isTruncated(page)
          ? "the page was cut before its embedded state ended"
          : "the embedded state script is not closed",
      };
    if (close - open > STATE_MAX)
      return { unread: `the embedded state is larger than ${STATE_MAX} characters` };
    return { text: body.slice(open + 1, close) };
  }
  return undefined;
}

/** A Qwik site, from the markup its server writes. */
export function isQwikSite(page: PageSnapshot): boolean {
  const body = bodyOf(page);
  if (body.includes("q:container=") || body.includes("q:container ")) return true;
  if (stateScript(page) !== undefined) return true;
  return page.scripts.some((s) => /\/build\/q-[A-Za-z0-9_-]+\.js/.test(s.slice(0, 300)));
}

export type NamesRead = { names: string[] } | { unread: string };

/**
 * Property names of the objects in a Qwik serialization (`objs` of the page state, `_objs` of a
 * q-data answer): a flat array, so one pass, capped. Names only; they go into a Set of strings, never
 * onto a plain object, so `__proto__` and `constructor` are ordinary names.
 */
export function namesOfSerialized(text: string, unescape: boolean): NamesRead {
  let doc: unknown;
  try {
    doc = JSON.parse(unescape ? text.replace(/\\x3C(\/?script)/gi, "<$1") : text);
  } catch {
    return { unread: "the serialized state is not JSON this reader understands" };
  }
  const objs: unknown =
    doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? ((doc as { objs?: unknown })["objs"] ?? (doc as { _objs?: unknown })["_objs"])
      : undefined;
  if (!Array.isArray(objs))
    return {
      unread: "the serialized state has no objs list (another Qwik version's format: uncited)",
    };
  const names = new Set<string>();
  for (const entry of objs.slice(0, OBJS_MAX)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const k of Object.keys(entry)) {
      if (names.size >= NAMES_MAX) break;
      if (k.length <= 80) names.add(k);
    }
  }
  return { names: [...names] };
}

/** The page's embedded Qwik state as names, or why it could not be read. Undefined when there is none. */
export function readState(page: PageSnapshot): NamesRead | undefined {
  const s = stateScript(page);
  if (s === undefined) return undefined;
  return "unread" in s ? s : namesOfSerialized(s.text, true);
}

/** `<route>/q-data.json` (`/q-data.json` for the root), no query. */
export function qDataAddress(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/q-data.json`;
  return u.href;
}

export const isQDataAddress = (u: string): boolean => {
  try {
    return new URL(u).pathname.endsWith("/q-data.json");
  } catch {
    return false;
  }
};

/** Names in a q-data.json answer, or why not. */
export function readQData(text: string, truncated = false): NamesRead {
  if (truncated || text.length > DATA_MAX)
    return { unread: "the q-data answer is larger than is read" };
  return namesOfSerialized(text, false);
}

/** Does this body look like a q-data answer (so a page address that returns it is serving data)? */
export const looksLikeQData = (body: string): boolean =>
  /^\s*\{\s*"_entry"\s*:\s*"[0-9a-z]+"\s*,\s*"_objs"\s*:/.test(body.slice(0, 200));

/**
 * How many times the page's markup names a server address: `?qfunc=` (a `server$` call) or
 * `?qaction=` (a `routeAction$` form, index.qwik.mjs actionPath). Names them; never calls them.
 */
export function qfuncCount(page: PageSnapshot): number {
  const body = bodyOf(page);
  let n = 0;
  for (const key of ["qfunc=", "qaction="])
    for (let at = body.indexOf(key); at >= 0 && n < 1000; at = body.indexOf(key, at + key.length))
      n += 1;
  return n;
}

/** Why this page is a Qwik dev server's, if it is. Each is a marker the dev server writes. */
export function devMarkers(page: PageSnapshot): string[] {
  const body = bodyOf(page);
  const out: string[] = [];
  if (/q:render=["'][a-z-]*-dev/.test(body)) out.push("q:render ssr-dev");
  if (/q:manifest-hash=["']?dev/.test(body)) out.push("q:manifest-hash dev");
  for (const m of ["/@vite/client", "/@qwik-city-plan"])
    if (page.scripts.some((s) => s.includes(m)) || body.includes(m)) out.push(m);
  return out;
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
