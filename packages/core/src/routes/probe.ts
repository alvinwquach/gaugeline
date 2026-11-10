import { ConfigError, NetworkError } from "../errors.js";
import { FetchError, type Fetcher, type GetOptions, type Hop } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import type { RouteEntry } from "./discover.js";

/**
 * Ask each route the code treats as signed-in for its page, with no session, and say whether it
 * refused or handed the page over. One GET each, to an address built from the route file's own
 * path: no cookie, no Authorization, no Referer, no query string. The body is read only as far as
 * LIMITS.routeProbeBytes to tell a sign-in form from a page, and is never kept: what stays of an
 * answer is a status, a size and a label. There is no option to send a session; the fetcher call
 * below is the only request in this file and it is anonymous.
 */

export type ProbeResult = "refused" | "redirected-to-login" | "handed-over" | "not-found" | "error";

/** What one route answered, in labels and numbers. Never the body. */
export interface RouteAnswer {
  result: ProbeResult;
  status?: number;
  /** Bytes of body read, at most LIMITS.routeProbeBytes. */
  bytes?: number;
  /** More body than was read: `bytes` is a lower bound (unless contentLength says more). */
  capped?: boolean;
  /** The Content-Length the route sent, when it sent one. */
  contentLength?: number;
  /** The body held a sign-in form (a password field): a 200 that is a refusal. */
  signInForm?: boolean;
  /** The 200 had nothing in it. */
  empty?: boolean;
  /** A redirect's target: a path, or a host when it leaves the site. No query string. */
  to?: string;
  /** Why the answer says nothing about the route (result "error"). */
  note?: string;
}

export interface SkippedRoute {
  path: string;
  file: string;
  /** Reads after "not probed:". */
  reason: string;
}

/** Which of the routes that expect a session are asked, and which are left out and why. */
export function planProbes(routes: readonly RouteEntry[]): {
  probe: RouteEntry[];
  skipped: SkippedRoute[];
} {
  const skipped: SkippedRoute[] = [];
  const candidates: RouteEntry[] = [];
  const seen = new Set<string>();
  for (const r of [...routes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!r.expectsSession || seen.has(r.path)) continue;
    seen.add(r.path);
    if (r.dynamic)
      skipped.push({
        path: r.path,
        file: r.file,
        reason: "needs a real id",
      });
    else candidates.push(r);
  }
  const probe = candidates.slice(0, LIMITS.routeProbes);
  for (const r of candidates.slice(LIMITS.routeProbes))
    skipped.push({
      path: r.path,
      file: r.file,
      reason: `more than ${LIMITS.routeProbes} routes expect a session, and a run asks at most ${LIMITS.routeProbes}, in sorted order`,
    });
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { probe, skipped };
}

const textOf = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");

/** The label kept of the start of a body: no sign-in form, a sign-in form, or nothing. */
export function sniffPage(bytes: Uint8Array): string {
  if (textOf(bytes).trim() === "") return "empty";
  return /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(textOf(bytes)) ? "login" : "page";
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function pathOnly(url: URL): string {
  return url.pathname === "" ? "/" : url.pathname;
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** One answer, judged. Pure: the status, the headers, the label of the body's start and its length. */
export function classifyAnswer(hop: Hop, address: string): RouteAnswer {
  const status = hop.status;
  const base: RouteAnswer = { result: "error", status };
  if (REDIRECTS.has(status)) {
    const location = hop.headers.location;
    if (!location) return { ...base, note: `answered ${status} with no address to go to` };
    let target: URL;
    try {
      target = new URL(location.trim(), address);
    } catch {
      return { ...base, note: `answered ${status} to an address that could not be read` };
    }
    const from = new URL(address);
    if (target.origin === from.origin) {
      if (trimSlash(pathOnly(target)) === trimSlash(pathOnly(from)))
        return {
          ...base,
          note: `answered ${status} to the same address, so there is nothing to judge`,
        };
      return { result: "redirected-to-login", status, to: pathOnly(target) };
    }
    return { result: "redirected-to-login", status, to: target.host };
  }
  if (status === 401 || status === 403) return { result: "refused", status };
  if (status === 404) return { result: "not-found", status };
  if (status === 200) {
    const bytes = hop.bytes ?? 0;
    const length = Number(hop.headers["content-length"]);
    const answer: RouteAnswer = {
      result: "handed-over",
      status,
      bytes,
      ...(Number.isInteger(length) && length >= 0 ? { contentLength: length } : {}),
      ...(bytes >= LIMITS.routeProbeBytes ? { capped: true } : {}),
    };
    if (hop.peek === "login") return { ...answer, result: "refused", signInForm: true };
    if (hop.peek === "empty") return { ...answer, empty: true };
    return answer;
  }
  return {
    ...base,
    note: `answered ${status}, which says nothing about whether it asks for a session`,
  };
}

/** How a route is asked: a visitor with no session, no cookie, no Authorization, no Referer, no redirects followed. */
export function anonymousPageAsk(): GetOptions {
  return {
    anonymous: true,
    maxRedirects: 0,
    headers: {
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      // Not compressed, so the start of the body can be read as it is.
      "accept-encoding": "identity",
    },
    peek: { maxBytes: LIMITS.routeProbeBytes, sniff: sniffPage },
  };
}

/** The address of a route on the site at `base`: base path and route path, no query string, no fragment. */
export function routeAddress(base: URL, path: string): string {
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = new URL(base.origin);
  url.pathname = `${prefix}${path === "/" ? (prefix === "" ? "/" : "") : path}`;
  return url.href;
}

function parseBase(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError(`${base} is not an address the site can be asked at.`, {
      hint: "Give the running site's address, such as https://example.com or http://127.0.0.1:3000.",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ConfigError("--base must be an http or https address.", {
      hint: "Give the running site's address, such as https://example.com.",
    });
  // Credentials in an address become an Authorization header. This check sends none.
  if (url.username !== "" || url.password !== "")
    throw new ConfigError("--base must not carry a user name or a password.", {
      hint: "Gaugeline asks with no session and sends no credential, so leave them out of the address.",
    });
  return url;
}

/** Run `work` over `items` with at most `limit` at once. */
async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Ask every route that expects a session and has no dynamic segment, at most LIMITS.routeProbes of
 * them and at most LIMITS.concurrency at once, and return what each answered by path. The routes
 * left out are returned with the reason. A refused address (a private one without --allow-private)
 * stops the run; any other failure is that route's "error".
 */
export async function probeRouteDetails(
  routes: readonly RouteEntry[],
  base: string,
  fetcher: Fetcher,
): Promise<{ answers: Map<string, RouteAnswer>; skipped: SkippedRoute[] }> {
  const root = parseBase(base);
  const { probe, skipped } = planProbes(routes);
  const answers = new Map<string, RouteAnswer>();
  await inPool(probe, LIMITS.concurrency, async (route) => {
    const address = routeAddress(root, route.path);
    try {
      const hops = await fetcher.get(address, anonymousPageAsk());
      const hop = hops.at(-1);
      answers.set(
        route.path,
        hop ? classifyAnswer(hop, address) : { result: "error", note: "the route did not answer" },
      );
    } catch (err) {
      if (
        err instanceof FetchError &&
        (err.reason === "blocked-address" || err.reason === "private-address-refused")
      )
        throw err;
      if (err instanceof NetworkError)
        answers.set(route.path, { result: "error", note: err.message });
      else throw err;
    }
  });
  return { answers, skipped };
}

/** The spec's shape: each probed route's path and what it did. See probeRouteDetails for the numbers. */
export async function probeRoutes(
  routes: readonly RouteEntry[],
  base: string,
  fetcher: Fetcher,
): Promise<Map<string, ProbeResult>> {
  const { answers } = await probeRouteDetails(routes, base, fetcher);
  return new Map([...answers].map(([path, a]) => [path, a.result]));
}
