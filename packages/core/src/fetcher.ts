import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { blockedRange } from "./addresses.js";
import type { Certificate } from "./dns/certificate.js";
import { classifyAddress, createAddressPolicy, isTarget } from "./net/address-policy.js";
import { decodeBody } from "./charset.js";
import { NetworkError, errorCodes } from "./errors.js";
import { LIMITS } from "./limits.js";
import { normaliseUrl } from "./normalise.js";
import type { RequestInfo } from "./progress.js";
import { Semaphore } from "./semaphore.js";
import {
  send,
  systemResolver,
  type ResolvedAddress,
  type Resolver,
  type TransportResponse,
} from "./transport.js";

/**
 * The only module allowed to touch the network. Every request to a checked site goes through here:
 * GET or HEAD only, at most `concurrency` at a time, a named user agent, every redirect hop kept.
 */

export interface Hop {
  url: string;
  status: number;
  headers: Record<string, string>;
  body?: string;
  ms: number;
  /** The body passed the size cap and was cut there. */
  truncated?: boolean;
  /** Bytes of body read, after any Content-Encoding and gzip file decoding, before the charset. */
  bytes?: number;
  /** Set on the first hop when https did not answer and http was used instead. */
  fallbackFrom?: string;
  /** Over https: the certificate this hop's server presented. */
  certificate?: Certificate;
  /** Set when this hop was not requested: a redirect to a non-public address off the target. */
  error?: "private-address-refused";
}

export type FetchErrorReason =
  | "not-found"
  | "refused"
  | "timeout"
  | "tls"
  | "loop"
  | "too-many-redirects"
  | "blocked-address"
  | "private-address-refused"
  | "network";

/** A NetworkError that also carries the hops received before it stopped. */
export class FetchError extends NetworkError {
  readonly reason: FetchErrorReason;
  readonly hops: Hop[];
  constructor(
    reason: FetchErrorReason,
    message: string,
    url: string,
    hops: Hop[],
    cause?: unknown,
    hint?: string,
  ) {
    super(message, { url, cause, ...(hint === undefined ? {} : { hint }) });
    this.reason = reason;
    this.hops = hops;
  }
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|EPROTO/;

/** Turn a low-level fetch failure into one plain sentence and one thing to try. */
export function describeNetworkFailure(
  url: string,
  err: unknown,
  timeoutMs: number,
): { reason: FetchErrorReason; message: string; hint: string } {
  const host = hostOf(url);
  if (isTimeout(err)) {
    return {
      reason: "timeout",
      message: `${host} did not answer within ${timeoutMs / 1000} seconds.`,
      hint: "Check the site loads in a browser, then try again in a minute.",
    };
  }
  const codes = errorCodes(err);
  if (codes.some((c) => c === "ENOTFOUND" || c === "EAI_NONAME" || c === "EAI_AGAIN")) {
    return {
      reason: "not-found",
      message: `${host} could not be found. Check the spelling.`,
      hint: "Type the address the way it appears in a browser, for example example.com.",
    };
  }
  if (codes.some((c) => c === "ECONNREFUSED")) {
    return {
      reason: "refused",
      message: `${host} refused the connection.`,
      hint: "Check the site is running, and the port if you typed one.",
    };
  }
  if (codes.some((c) => c === "UND_ERR_CONNECT_TIMEOUT" || c === "ETIMEDOUT")) {
    return {
      reason: "timeout",
      message: `${host} did not answer within ${timeoutMs / 1000} seconds.`,
      hint: "Check the site loads in a browser, then try again in a minute.",
    };
  }
  if (codes.some((c) => TLS_CODES.test(c))) {
    return {
      reason: "tls",
      message: `${host} has a security certificate that could not be verified.`,
      hint: "Open the address in a browser to see the certificate warning, or try http:// if the site has no certificate.",
    };
  }
  return {
    reason: "network",
    message: `${host} could not be reached.`,
    hint: "Check your internet connection and the address.",
  };
}

export interface FetcherOptions {
  concurrency?: number;
  timeoutMs?: number;
  userAgent?: string;
  maxHops?: number;
  maxBodyBytes?: number;
  /**
   * Send requests for a host somewhere else, like curl --resolve: { "shop.example": "127.0.0.1:4000" }.
   * Hops keep the address that was asked for. Used to check a site before DNS points at it, and by
   * the fixture sites in tests.
   */
  hosts?: Record<string, string>;
  /** Called after every request (for --verbose). Gets the method, address, status and time only. */
  onRequest?: (info: RequestInfo) => void;
  /**
   * Allow loopback, private, link-local, CGNAT and other non-public addresses. Off by default: a
   * checked site must not be able to point Gaugeline at your own machine or network.
   */
  allowPrivate?: boolean;
  /** How host names become addresses. Defaults to the system resolver; tests inject one. */
  resolver?: Resolver;
  /** Over https, trust only this certificate authority (PEM). Verification stays on. */
  ca?: string;
  /**
   * The address the person typed. Requests to its host and port may go anywhere it resolves,
   * private and loopback included; every other request must resolve to a public address, or it is
   * refused before a socket opens ("private-address-refused").
   */
  target?: string;
  /** Share the in-flight limit with other fetchers (the app's runs share one). */
  semaphore?: Semaphore;
  /** Replace the network, e.g. with a recorded cassette. hosts/allowPrivate/resolver then do nothing. */
  transport?: Transport;
  /**
   * Extra headers per request, asked for each hop's own address (a protected preview's secret goes
   * to its origin only, so a redirect to another origin sends none). Never logged.
   */
  headersFor?: (url: URL) => Record<string, string> | undefined;
}

export interface GetOptions {
  headers?: Record<string, string>;
  method?: "GET" | "HEAD";
  /** Send `headers` only to hops on the first address's origin: a redirect elsewhere gets none. */
  headersSameOrigin?: boolean;
}

export interface Fetcher {
  /** Every redirect hop; the last one is the final response. */
  get(url: string, opts?: GetOptions): Promise<Hop[]>;
  /**
   * Fetch what someone typed. A bare domain ("example.com") is tried as https first and, if the
   * secure address does not answer at all, as http. The fallback is recorded on the first hop.
   */
  getSite(address: string, opts?: GetOptions): Promise<Hop[]>;
  readonly stats: { readonly requests: number; readonly maxInFlight: number };
}

export const DEFAULT_USER_AGENT = "Gaugeline/0.1 (read-only site check)";

const READ_ONLY = new Set(["GET", "HEAD"]);

/** Gaugeline never changes a site: anything but GET or HEAD is refused before it is sent. */
export function assertReadOnly(method: string): void {
  if (!READ_ONLY.has(method.toUpperCase())) {
    throw new TypeError(`Gaugeline is read-only: refusing to send a ${method} request.`);
  }
}

/** Moved to normalise.ts (G04a); re-exported so existing imports keep working. */
export { normaliseUrl };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A gzip file (a sitemap.xml.gz) rather than a gzip Content-Encoding: the first two bytes. */
function isGzipFile(buf: Buffer): boolean {
  return buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

async function readCapped(
  body: Readable,
  cap: number,
  contentType: string | undefined,
  unzip = true,
): Promise<{ body: string; truncated: boolean; bytes: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      if (size + buf.byteLength > cap) {
        chunks.push(buf.subarray(0, cap - size));
        size = cap;
        truncated = true;
        body.destroy();
        break;
      }
      chunks.push(buf);
      size += buf.byteLength;
    }
  } catch (err) {
    // A body that ends early or fails to decompress keeps what arrived and is marked truncated.
    if (isTimeout(err)) throw err;
    truncated = true;
  }
  const buf = Buffer.concat(chunks, size);
  // No text starts with 0x1f 0x8b, so a body that does is a gzip file: read it decompressed,
  // under the same cap. One level only: a gzip inside a gzip stays as it is.
  if (unzip && isGzipFile(buf)) {
    const inner = await readCapped(
      Readable.from([buf]).pipe(createGunzip()),
      cap,
      contentType,
      false,
    );
    return { ...inner, truncated: inner.truncated || truncated };
  }
  return { body: decodeBody(buf, contentType), truncated, bytes: size };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface TransportRequest {
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  timeoutMs: number;
}

/**
 * How a request leaves the fetcher. The default is the network; tests inject a recorded cassette
 * (packages/testkit). An injected transport gets the address as asked for and never touches DNS.
 */
export type Transport = (url: URL, req: TransportRequest) => Promise<TransportResponse>;

export interface NetworkTransportOptions {
  hosts?: Record<string, string>;
  allowPrivate?: boolean;
  resolver?: Resolver;
  /** Called once a request has passed the address check and is about to be sent. */
  onSend?: () => void;
  /** Over https, trust only this certificate authority (PEM). */
  ca?: string;
  /** See FetcherOptions.target. */
  target?: string;
}

/**
 * The real network: apply the hosts mapping, resolve the host once, refuse any non-public address
 * (unless allowPrivate, or the host comes from the explicit hosts mapping), then connect to the
 * address that was checked.
 */
export function createNetworkTransport(options: NetworkTransportOptions = {}): Transport {
  const hostMap = new Map(
    Object.entries(options.hosts ?? {}).map(([from, to]) => [from.toLowerCase(), to] as const),
  );
  const resolver = options.resolver ?? systemResolver;
  /** The address actually requested: the logical host swapped for its mapped target, if any. */
  const route = (u: URL): URL => {
    const target = hostMap.get(u.host) ?? hostMap.get(u.hostname);
    if (target === undefined) return u;
    const routed = new URL(u.href);
    routed.host = target;
    return routed;
  };
  async function checkedAddress(
    logical: URL,
    target: URL,
    mapped: boolean,
  ): Promise<ResolvedAddress> {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const family = isIP(host);
    const addresses: ResolvedAddress[] =
      family === 0 ? await resolver(host) : [{ address: host, family: family === 6 ? 6 : 4 }];
    if (addresses.length === 0) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    if (!mapped && options.target !== undefined) {
      // The typed address may resolve anywhere; everything else must be public unless it is on
      // the typed host and port. Judged on each resolved address, before any socket opens.
      const typed = new URL(options.target);
      const policy = createAddressPolicy(typed);
      const kind = isTarget(logical, typed) ? "target" : "followed";
      for (const a of addresses)
        if (!policy(logical, a.address, kind))
          throw new FetchError(
            "private-address-refused",
            `${logical.host} resolves to ${a.address}, a ${classifyAddress(a.address)} address: Gaugeline follows redirects and links to non-public addresses only on the address you typed.`,
            logical.href,
            [],
          );
    } else if (!mapped && options.allowPrivate !== true) {
      for (const a of addresses) {
        const range = blockedRange(a.address);
        if (range !== undefined) {
          throw new FetchError(
            "blocked-address",
            `${logical.host} points at a ${range} address (${a.address}), which Gaugeline does not request.`,
            logical.href,
            [],
            undefined,
            "To check a site on your own computer or network, add --allow-private.",
          );
        }
      }
    }
    const first = addresses[0];
    if (!first) throw new Error("unreachable");
    return first;
  }
  return async (url, req) => {
    const target = route(url);
    const pinned = await checkedAddress(url, target, target !== url);
    options.onSend?.();
    return send(target, { ...req, pinned, ...(options.ca ? { ca: options.ca } : {}) });
  };
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const {
    concurrency = LIMITS.concurrency,
    timeoutMs = 10_000,
    userAgent = DEFAULT_USER_AGENT,
    maxHops = LIMITS.redirectHops,
    maxBodyBytes = LIMITS.bodyBytes,
  } = options;
  const gate = options.semaphore ?? new Semaphore(concurrency);
  let requests = 0;
  const transport: Transport = options.transport
    ? (url, req) => {
        requests += 1;
        return (options.transport as Transport)(url, req);
      }
    : createNetworkTransport({
        ...(options.hosts ? { hosts: options.hosts } : {}),
        ...(options.allowPrivate ? { allowPrivate: true } : {}),
        ...(options.resolver ? { resolver: options.resolver } : {}),
        ...(options.ca ? { ca: options.ca } : {}),
        ...(options.target ? { target: options.target } : {}),
        onSend: () => {
          requests += 1;
        },
      });

  /** In-flight promises, so two checks asking at the same moment share one request. */
  const memo = new Map<string, Promise<Hop[]>>();

  async function requestOnce(
    url: string,
    method: "GET" | "HEAD",
    headers: Record<string, string>,
  ): Promise<{ hop: Hop; location: string | null }> {
    assertReadOnly(method);
    return gate.run(async () => {
      const started = performance.now();
      let res;
      const target = new URL(url);
      try {
        res = await transport(target, {
          method,
          headers: { "user-agent": userAgent, ...headers, ...options.headersFor?.(target) },
          timeoutMs,
        });
      } catch (err) {
        options.onRequest?.({
          method,
          url,
          status: "error",
          ms: Math.round(performance.now() - started),
        });
        if (err instanceof FetchError) throw err;
        const d = describeNetworkFailure(url, err, timeoutMs);
        throw new FetchError(d.reason, d.message, url, [], err, d.hint);
      }
      const hop: Hop = {
        url,
        status: res.status,
        headers: res.headers,
        ms: 0,
        ...(res.certificate ? { certificate: res.certificate } : {}),
      };
      const location = REDIRECTS.has(res.status) ? (res.headers.location ?? null) : null;
      if (location !== null || method === "HEAD") {
        res.body.destroy();
      } else {
        try {
          const { body, truncated, bytes } = await readCapped(
            res.body,
            maxBodyBytes,
            res.headers["content-type"],
          );
          hop.body = body;
          hop.bytes = bytes;
          if (truncated) hop.truncated = true;
        } catch (err) {
          throw new FetchError(
            "timeout",
            `${hostOf(url)} did not finish sending the page within ${timeoutMs / 1000} seconds.`,
            url,
            [],
            err,
          );
        }
      }
      hop.ms = Math.round(performance.now() - started);
      options.onRequest?.({ method, url, status: hop.status, ms: hop.ms });
      return { hop, location };
    });
  }

  async function follow(start: string, opts: GetOptions): Promise<Hop[]> {
    const method = opts.method ?? "GET";
    assertReadOnly(method);
    const hops: Hop[] = [];
    const visited = new Set<string>();
    const origin = new URL(start).origin;
    let current = start;
    for (;;) {
      visited.add(normaliseUrl(current));
      let step;
      const headers =
        opts.headersSameOrigin && new URL(current).origin !== origin ? {} : (opts.headers ?? {});
      try {
        step = await requestOnce(current, method, headers);
      } catch (err) {
        // A redirect to a non-public address off the target: recorded as a hop that was not
        // requested, and the trail ends there.
        if (
          err instanceof FetchError &&
          err.reason === "private-address-refused" &&
          hops.length > 0
        )
          throw new FetchError(err.reason, err.message, err.url, [
            ...hops,
            { url: current, status: 0, headers: {}, ms: 0, error: "private-address-refused" },
          ]);
        if (err instanceof FetchError) {
          throw new FetchError(err.reason, err.message, err.url, hops, err.cause, err.hint);
        }
        throw err;
      }
      hops.push(step.hop);
      if (step.location === null) return hops;
      const next = new URL(step.location.trim(), current).href;
      if (visited.has(normaliseUrl(next))) {
        throw new FetchError(
          "loop",
          `${hostOf(start)} redirects in a loop.`,
          start,
          hops,
          undefined,
          `Follow the redirects from ${hostOf(start)} and remove the one that points back.`,
        );
      }
      if (hops.length >= maxHops) {
        throw new FetchError(
          "too-many-redirects",
          `Stopped after ${maxHops} redirects (too many redirects).`,
          start,
          hops,
        );
      }
      current = next;
    }
  }

  function get(url: string, opts: GetOptions = {}): Promise<Hop[]> {
    const method = opts.method ?? "GET";
    assertReadOnly(method);
    const normal = normaliseUrl(url);
    const key = `${method} ${normal}${opts.headers ? ` ${JSON.stringify(Object.entries(opts.headers).sort())}` : ""}${opts.headersSameOrigin ? " same-origin" : ""}`;
    let pending = memo.get(key);
    if (!pending) {
      pending = follow(normal, opts);
      memo.set(key, pending);
    }
    return pending;
  }

  async function getSite(address: string, opts: GetOptions = {}): Promise<Hop[]> {
    const trimmed = address.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return get(trimmed, opts);
    const secure = `https://${trimmed}`;
    try {
      return await get(secure, opts);
    } catch (err) {
      // Only fall back when https did not answer at all, never on an HTTP status.
      if (
        !(err instanceof FetchError) ||
        err.hops.length > 0 ||
        !["network", "timeout", "refused", "tls"].includes(err.reason)
      ) {
        throw err;
      }
      const hops = await get(`http://${trimmed}`, opts);
      const [first, ...rest] = hops;
      return first ? [{ ...first, fallbackFrom: normaliseUrl(secure) }, ...rest] : hops;
    }
  }

  return {
    get,
    getSite,
    stats: {
      get requests() {
        return requests;
      },
      get maxInFlight() {
        return gate.maxInFlight;
      },
    },
  };
}
