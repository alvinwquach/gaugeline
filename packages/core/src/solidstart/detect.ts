import type { PageSnapshot } from "../snapshot.js";
import { NAMES_MAX } from "../qwik/detect.js";

/**
 * SolidStart, from what a page already says. Read from solid-js 1.9.19 and @solidjs/start 1.5.1
 * package source (npm; docs unreachable from the build host: [docs: package source]):
 *  - server rendering writes `window._$HY||(...)(_$HY={events:[],completed:new WeakSet,r:{},fe(){}})`
 *    and the serialized data as scripts that write to `_$HY.r` (web/dist/server.js, GLOBAL_IDENTIFIER);
 *    hydratable elements carry `data-hk`;
 *  - assets are served under `/_build/assets/`, and `window.manifest = {...}` is written inline
 *    (@solidjs/start config and StartServer.jsx); the dev server serves `/_build/@fs/...`;
 *  - a `"use server"` function is called at `/_server` (`/_server?id=<id>&name=<name>` for a GET,
 *    headers X-Server-Id and X-Server-Instance for a POST) (dist/runtime/server-runtime.js).
 * A plain solid-js server render has `_$HY` too, so SolidStart needs one of the Start markers as well.
 * Linear scans over a capped slice of the body.
 */

const SCAN_MAX = 400_000;
const STATE_MAX = 300_000;

const bodyOf = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, SCAN_MAX);
const isTruncated = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;
const identChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

export function isSolidStartSite(page: PageSnapshot): boolean {
  const body = bodyOf(page);
  const startMarker =
    body.includes("/_build/") ||
    body.includes("window.manifest") ||
    page.scripts.some((s) => s.includes("/_build/"));
  return (body.includes("_$HY") && startMarker) || body.includes("/_server?id=");
}

/** The inline scripts that write to `_$HY.r`, as text, capped; and whether the page was cut inside one. */
function stateScripts(page: PageSnapshot): { texts: string[]; cut: boolean } {
  const body = bodyOf(page);
  const texts: string[] = [];
  let total = 0;
  let cut = false;
  let from = 0;
  for (let tries = 0; tries < 400 && total < STATE_MAX; tries += 1) {
    const open = body.indexOf("<script", from);
    if (open < 0) break;
    const gt = body.indexOf(">", open);
    if (gt < 0) break;
    const close = body.indexOf("</script", gt);
    const text = body.slice(gt + 1, close < 0 ? body.length : close);
    if (close < 0 && isTruncated(page) && text.includes("_$HY.r")) cut = true;
    from = close < 0 ? body.length : close + 8;
    if (!text.includes("_$HY.r") || text.startsWith("window._$HY||")) continue;
    texts.push(text.slice(0, STATE_MAX - total));
    total += text.length;
  }
  return { texts, cut };
}

/** The index of the quote that closes the string opened at `i` (or the end when it does not). */
function endOfString(src: string, i: number): number {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === "\\") j += 1;
    else if (src[j] === quote) return j;
  }
  return src.length;
}

/**
 * Property names in a JavaScript literal (what seroval writes), names only, once each, in first-seen
 * order. Strings are skipped, so a value that looks like `password: x` is not a name. Linear; capped.
 */
export function literalKeys(src: string): string[] {
  const seen = new Set<string>();
  let prev = "";
  for (let i = 0; i < src.length && seen.size < NAMES_MAX; i += 1) {
    const c = src[i] ?? "";
    if (/\s/.test(c)) continue;
    let name: string | undefined;
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(src, i);
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

/** Names in the page's hydration data, or why it could not be read. Undefined when the page has none. */
export function readHydration(
  page: PageSnapshot,
): { names: string[] } | { unread: string } | undefined {
  const { texts, cut } = stateScripts(page);
  if (cut) return { unread: "the page was cut before its hydration data ended" };
  if (texts.length === 0) return undefined;
  const names = new Set<string>();
  for (const t of texts) for (const n of literalKeys(t)) names.add(n);
  return { names: [...names] };
}

/** How many times the page's markup names the `/_server` address. Names it; never calls it. */
export function serverFnCount(page: PageSnapshot): number {
  const body = bodyOf(page);
  let n = 0;
  for (
    let at = body.indexOf("/_server");
    at >= 0 && n < 1000;
    at = body.indexOf("/_server", at + 8)
  ) {
    const next = body[at + 8] ?? "";
    if (next === "" || next === "?" || next === "/" || next === '"' || next === "'" || next === "`")
      n += 1;
  }
  return n;
}

/** Why this page is a SolidStart dev server's, if it is. */
export function devMarkers(page: PageSnapshot): string[] {
  const body = bodyOf(page);
  const out: string[] = [];
  for (const m of ["/_build/@fs/", "/@vite/client"])
    if (page.scripts.some((s) => s.includes(m)) || body.includes(m)) out.push(m);
  return out;
}
