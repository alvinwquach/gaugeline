import { Readable } from "node:stream";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { resolveQueryAllow } from "../../fetch/query-registry.js";
import {
  addressProblem,
  allowProblems,
  bodyProblem,
  type ReadOnlyQueryAllow,
} from "../../fetch/read-only-query.js";
import type { AdapterMember, ContentAdapter, PublishedOptions, TypeCount } from "../types.js";

/**
 * The shared contract every adapter must pass. An adapter's branch adds one ContractEntry to
 * entries.ts and writes no tests of its own for these rules: the suite (contract.test.ts) runs the
 * same checks against every entry, over recorded (invented) answers, never the network.
 */
export interface ContractEntry {
  /** The adapter's id: what describe.each prints and what gaugeline.adapters.json calls it. */
  id: string;
  /** The adapter over this fetcher. `sleep` must not wait: it is how a backoff is observed. */
  make(world: { fetcher: Fetcher; sleep: (ms: number) => Promise<void> }): ContentAdapter;
  /** The recorded answers of a healthy platform. A new transport for each call, so nothing carries over. */
  transport(): Transport;
  /**
   * The key the adapter is given. It must never appear in anything the adapter returns or throws.
   * Leave it out for an adapter that asks for no key (describe().noKey): the suite then checks that
   * no request carries an Authorization header or a cookie.
   */
  key?: string;
  /**
   * How the key is sent when it is not "Bearer <key>" on every request. For a platform that needs no key to read
   * what is published (WordPress): the exact header value, which only the requests that need the key carry. The
   * published reads carry none, so the key never goes where it is not needed.
   */
  keyHeader?: { value: string };
  /**
   * The key is the whole Authorization header value, with no "Bearer " in front (Wix's API keys), on every
   * request. It is still only ever in that header: never in an address, a body, a result or a message.
   */
  keyRaw?: true;
  /**
   * The Authorization header is this text followed by the key, exactly, on every request (Payload's
   * `users API-Key <key>`). Instead of "Bearer <key>"; the key is still only ever in that header.
   */
  keyPrefix?: string;
  /**
   * For a platform that takes its key in headers other than Authorization (Contentstack's `api_key` and
   * `access_token`): every request carries exactly these headers (lower-case names), and none carries an
   * Authorization header. The values must not appear in an address, a result or a message.
   */
  keyHeaders?: Readonly<Record<string, string>>;
  /**
   * The read-only query entries the adapter's own file EXPORTS (ADR-0006), if it sends any: the frozen
   * objects `registerQueryAllow` returned, imported here, not written out again. The suite checks
   * each is registered (the fetcher only sends to a registered id) and well formed, and that every
   * POST the adapter builds matches one entry and carries a body that is a query. Leave it out for an
   * adapter that only GETs: the suite then fails on the first POST it builds.
   */
  queryAllow?: readonly ReadOnlyQueryAllow[];
  /** For an entry whose host is `{ configured }`: the host the adapter's configuration gives, by entry id. */
  queryHosts?: Readonly<Record<string, string>>;
  /**
   * What fieldCounts() does for a content type the platform does not have. Default: counts of 0 (a type with
   * no items). "could-not-check": an AdapterCouldNotCheck that names the type, for a platform that lists its
   * content types and so knows a name is wrong (Contentful); a typo is then not read as an empty type.
   */
  unknownType?: "could-not-check";
  /** Text that is in the platform's content, including an unpublished draft, and must never come back. */
  secrets: readonly string[];
  expected: {
    types: readonly TypeCount[];
    /**
     * `missing` is a field no item has: its count is 0, not an error. Leave it out for an adapter
     * whose platform has no fields (a sitemap): fieldCounts() must then be could-not-check with a
     * reason that says "Not applicable", and every `fieldHashes` is empty.
     */
    fields?: { type: string; counts: Readonly<Record<string, number>>; missing: string };
    published: {
      options: PublishedOptions;
      /** The ids published() gives for `options`, in order. */
      ids: readonly string[];
    };
    draftsReachable: boolean | "not-applicable";
  };
  /** A published() read that is cut short: the first `succeedFirst` requests are answered, the rest are 429. */
  rateLimit: {
    options: PublishedOptions;
    succeedFirst: number;
    atLeast: number;
    /** The platform also sends its limit as a 403 with x-ratelimit-remaining: 0 (GitHub): that form must be a rate limit too. */
    alsoAs403?: true;
  };
  /** For an adapter with members(): the recorded answers, what comes back, and the addresses that must not. */
  members?: {
    transport(): Transport;
    expected: readonly AdapterMember[];
    addresses: readonly string[];
  };
}

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The JSON text of a POST's body. */
  body?: string;
}

/** Every request the transport is asked to send, in order. */
export function recording(base: Transport, seen: Seen[]): Transport {
  return (url, req) => {
    seen.push({
      method: req.method,
      url: url.href,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    return base(url, req);
  };
}

const tooMany = (retryAfter: string) =>
  Promise.resolve({
    status: 429,
    headers: { "retry-after": retryAfter, "content-type": "application/json" },
    body: Readable.from([Buffer.from("{}")]),
  });

/** From request number `after` (0-based) on, `times` requests are answered 429 with this Retry-After. */
export function rateLimited(
  base: Transport,
  limit: { after: number; times: number; retryAfter?: string },
): Transport {
  let n = 0;
  return (url, req) => {
    const at = n++;
    if (at >= limit.after && at < limit.after + limit.times)
      return tooMany(limit.retryAfter ?? "2") as ReturnType<Transport>;
    return base(url, req);
  };
}

/** From request number `after` on, every request is a 403 that says the hourly limit is used up and when it resets. */
export function rateLimitedAs403(base: Transport, after: number): Transport {
  let n = 0;
  return (url, req) => {
    if (n++ < after) return base(url, req);
    return Promise.resolve({
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
      body: Readable.from([Buffer.from('{"message":"API rate limit exceeded"}')]),
    }) as ReturnType<Transport>;
  };
}

/** Every request is answered with this status (401 or 403: the key may not read). */
export function refusing(status: 401 | 403): Transport {
  return () =>
    Promise.resolve({
      status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from("{}")]),
    }) as ReturnType<Transport>;
}

const READ_ONLY = new Set(["GET", "HEAD"]);
const GRAPHQL_WRITE = /(^|[\s{}(),])(mutation|subscription)\b/i;

/**
 * Why a POST is not a read-only query under these allowlist entries, or undefined when it is one.
 * The reason never repeats the body.
 */
function postProblem(
  r: Seen,
  allows: readonly ReadOnlyQueryAllow[],
  hosts: Readonly<Record<string, string>>,
): string | undefined {
  const url = new URL(r.url);
  const candidates = allows.filter((a) => addressProblem(url, a, hosts[a.id]) === undefined);
  if (candidates.length === 0)
    return `POST ${r.url}: matches no allowlist entry (https, host, path, no query string)`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body ?? "");
  } catch {
    return `POST ${r.url}: the body is not JSON`;
  }
  const reasons = candidates.map((a) => bodyProblem(a, parsed));
  if (reasons.some((why) => why === undefined)) return undefined;
  return `POST ${r.url}: the body is not a read-only query (${reasons[0]})`;
}

/**
 * What is wrong with the requests an adapter built: a PUT, PATCH, DELETE or any other method (never
 * allowed); a POST that matches no entry of the adapter's `queryAllow` or whose body is not a query
 * of that entry's shape (ADR-0006); or a GraphQL document that is not a query (a mutation or a
 * subscription) in the address. An empty list is the contract's "no request that could write is
 * ever built".
 */
export function requestProblems(
  seen: readonly Seen[],
  allows: readonly ReadOnlyQueryAllow[] = [],
  hosts: Readonly<Record<string, string>> = {},
): string[] {
  const out: string[] = [];
  for (const r of seen) {
    const method = r.method.toUpperCase();
    if (method === "POST") {
      const why = postProblem(r, allows, hosts);
      if (why !== undefined) out.push(why);
    } else if (!READ_ONLY.has(method))
      out.push(`${r.method} ${r.url}: only GET, HEAD and an allowlisted query POST are ever built`);
    const url = new URL(r.url);
    for (const [name, value] of url.searchParams)
      if (["query", "variables", "operationName"].includes(name) && GRAPHQL_WRITE.test(value))
        out.push(`${r.url}: the ${name} parameter holds a GraphQL mutation or subscription`);
  }
  return out;
}

/** What is wrong with the allowlist entries an adapter declares (none is fine for an adapter that only GETs). */
export function allowlistProblems(allows: readonly ReadOnlyQueryAllow[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const a of allows) {
    if (ids.has(a.id)) out.push(`${a.id}: the id is used twice`);
    ids.add(a.id);
    for (const p of allowProblems(a, { stored: true })) out.push(`${a.id}: ${p}`);
    // The fetcher resolves an id from the registry; an entry written out here instead would be
    // refused at run time, so it must be the very object the adapter's file registered.
    if (resolveQueryAllow(a.id) !== a) out.push(`${a.id}: not the entry the adapter registered`);
    if (!Object.isFrozen(a)) out.push(`${a.id}: not frozen`);
  }
  return out;
}

/** The world one test runs in: an adapter over a recording fetcher, and the waits it asked for. */
export function world(entry: ContractEntry, wrap?: (healthy: Transport) => Transport) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const healthy = entry.transport();
  const fetcher = createFetcher({
    transport: recording(wrap ? wrap(healthy) : healthy, seen),
    timeoutMs: 5000,
  });
  const adapter = entry.make({
    fetcher,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { adapter, seen, sleeps };
}
