/**
 * The Function the Publish button calls: GET ?url=<page> -> JSON, on an address you own. Node (it
 * uses the core fetcher); it takes a standard Request and gives a standard Response, so it mounts
 * on a Sanity Function, a serverless route or a plain Node server.
 *
 * Read-only: GET only, no body read, no Sanity client and no token. It reads the one page the
 * address names (and its same-host links, as the post-publish check does) through the core
 * fetcher, which refuses private and metadata addresses, and it only ever reads the configured
 * site: any other address is refused before anything is requested. It stores nothing; a short
 * in-memory cache lets two editors who publish the same page at once share one check.
 */
import { checkPage, blocking, type GateSeverity, type GateTransport } from "./check.js";
import { ANSWER_VERSION, couldNotCheck, type GateAnswer } from "./answer.js";

export interface GateRequestOptions {
  /** The live site the Function may read, for example "https://lantern-yard.example". Nothing else is read. */
  site: string;
  /** The one origin allowed to read the answer, for example "https://lantern-yard.sanity.studio". Exact: no wildcard, no path. */
  allowOrigin: string;
  /** The lowest severity that holds a publish. Default "high". */
  blockOn?: GateSeverity;
  /** How long an answer is reused, in milliseconds. Default 10000; 0 keeps only checks that are running. */
  cacheMs?: number;
  /** Replaces the network; for tests. */
  transport?: GateTransport;
  now?: () => Date;
  /** Replaces the clock the cache uses (milliseconds); for tests. */
  clock?: () => number;
}

const MAX_URL = 2048;
const MAX_CACHED = 100;

const SAY = {
  method: "Only GET is answered.",
  origin: "This origin may not read the answer.",
  query: "Ask with exactly one parameter, url, holding a page on the configured site.",
  site: "That address is not on the configured site.",
} as const;

export function gateRequestHandler(
  options: GateRequestOptions,
): (request: Request) => Promise<Response> {
  if (!/^https?:\/\/[^\s/]/i.test(options.site) || !URL.canParse(options.site))
    throw new Error(
      "site must be a full http or https address, for example https://lantern-yard.example.",
    );
  const site = new URL(options.site);
  if (
    typeof options.allowOrigin !== "string" ||
    options.allowOrigin.includes("*") ||
    !URL.canParse(options.allowOrigin) ||
    new URL(options.allowOrigin).protocol !== "https:" ||
    new URL(options.allowOrigin).origin !== options.allowOrigin
  )
    throw new Error(
      "allowOrigin must be one exact https origin, with no wildcard, path or trailing slash, for example https://lantern-yard.sanity.studio.",
    );
  const { allowOrigin } = options;
  const blockOn = options.blockOn ?? "high";
  const cacheMs = options.cacheMs ?? 10_000;
  const clock = options.clock ?? Date.now;
  /** Insertion-ordered, so the oldest entry is the first key; a Map keeps lookup by address O(1). */
  const cache = new Map<string, { at: number; settled: boolean; answer: Promise<GateAnswer> }>();

  const reply = (
    status: number,
    body: unknown,
    origin: boolean,
    more: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        vary: "Origin",
        ...(origin ? { "access-control-allow-origin": allowOrigin } : {}),
        ...more,
      },
    });

  async function check(url: string): Promise<GateAnswer> {
    try {
      const report = await checkPage({
        url,
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      if (report.unreachable !== undefined)
        return { ...couldNotCheck(url, report.unreachable), checkedAt: report.checkedAt };
      const problems = blocking(report, blockOn);
      return {
        version: ANSWER_VERSION,
        status: problems.length === 0 ? "clean" : "findings",
        url,
        checkedAt: report.checkedAt,
        findings: problems,
      };
    } catch {
      // The reason is fixed: an error message could hold text from the page.
      return {
        ...couldNotCheck(url, "The check could not run."),
        checkedAt: (options.now ?? (() => new Date()))().toISOString(),
      };
    }
  }

  return async (request) => {
    const sent = request.headers.get("origin");
    const origin = sent === allowOrigin;
    if (request.method !== "GET")
      return reply(405, { error: SAY.method }, origin, { allow: "GET" });
    if (sent !== null && !origin) return reply(403, { error: SAY.origin }, false);
    const query = new URL(request.url).searchParams;
    const keys = [...query.keys()];
    const page = query.get("url");
    if (keys.length !== 1 || keys[0] !== "url" || page === null || page.length > MAX_URL)
      return reply(400, { error: SAY.query }, origin);
    // The address must be on the configured site, exactly: same scheme, host and port, no name or password.
    if (!URL.canParse(page)) return reply(400, { error: SAY.site }, origin);
    const target = new URL(page);
    if (target.origin !== site.origin || target.username !== "" || target.password !== "")
      return reply(400, { error: SAY.site }, origin);

    const now = clock();
    // A finished answer is reused for cacheMs; one still running is always shared.
    for (const [key, held] of cache)
      if (held.settled && now - held.at >= cacheMs) cache.delete(key);
    let entry = cache.get(page);
    if (entry === undefined) {
      const fresh = { at: now, settled: false, answer: check(page) };
      void fresh.answer.then(() => {
        fresh.settled = true;
        fresh.at = clock();
      });
      entry = fresh;
      cache.set(page, entry);
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
    }
    return reply(200, await entry.answer, origin);
  };
}
