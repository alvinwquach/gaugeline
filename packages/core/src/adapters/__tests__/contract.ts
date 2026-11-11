import { Readable } from "node:stream";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
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
  rateLimit: { options: PublishedOptions; succeedFirst: number; atLeast: number };
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
}

/** Every request the transport is asked to send, in order. */
export function recording(base: Transport, seen: Seen[]): Transport {
  return (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
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
 * What is wrong with the requests an adapter built: a method other than GET or HEAD, or a GraphQL
 * document that is not a query (a mutation or a subscription) in the address. An empty list is
 * the contract's "no request that could write is ever built".
 */
export function requestProblems(seen: readonly Seen[]): string[] {
  const out: string[] = [];
  for (const r of seen) {
    if (!READ_ONLY.has(r.method.toUpperCase()))
      out.push(`${r.method} ${r.url}: only GET and HEAD are ever built`);
    const url = new URL(r.url);
    for (const [name, value] of url.searchParams)
      if (["query", "variables", "operationName"].includes(name) && GRAPHQL_WRITE.test(value))
        out.push(`${r.url}: the ${name} parameter holds a GraphQL mutation or subscription`);
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
