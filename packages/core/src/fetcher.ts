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
  currentKind,
  type RequestError,
  type RequestKind,
  type RequestRecord,
} from "./request-log.js";
import { resolveQueryAllow } from "./fetch/query-registry.js";
import { QueryRefusedError, queryRefusal, serializeBody } from "./fetch/read-only-query.js";
import {
  send,
  systemResolver,
  type ResolvedAddress,
  type Resolver,
  type TransportResponse,
} from "./transport.js";

/**
 * The only module allowed to touch the network. Every request to a checked site goes through here:
 * GET or HEAD, at most `concurrency` at a time, a named user agent, every redirect hop kept.
 * The one other request it can send is `query()`: a POST to a documented read-only query endpoint
 * on an adapter's allowlist, with a body that is a query and never a write (ADR-0006).
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
  /** With GetOptions.peek: what `sniff` made of the first bytes. The bytes themselves are not kept. */
  peek?: string;
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

/**
 * Read only the start of a body: the first `maxBytes`, then the connection is closed. The bytes go
 * to `sniff` and are dropped; the hop keeps only the label `sniff` returns (Hop.peek), so a file's
 * content never sits in the run's memory or in a log. For asking whether a route hands a file over
 * without holding the file.
 */
export interface PeekOptions {
  maxBytes: number;
  sniff: (bytes: Uint8Array) => string;
}

export interface GetOptions {
  headers?: Record<string, string>;
  /**
   * Send nothing but the user agent and `headers`: not the per-address headers a protected preview
   * adds (FetcherOptions.headersFor). The fetcher has no cookie jar and sends no Referer, so this
   * is a visitor with no session. Asked separately from the same address without it.
   */
  anonymous?: boolean;
  /**
   * Read at most this many bytes of the body, then stop; the hop is flagged `truncated` when it was cut. It can
   * only lower the fetcher's own cap (`maxBodyBytes`), never raise it.
   */
  maxBytes?: number;
  /** Read only the first bytes of the body (see PeekOptions). The body of a HEAD or a redirect is never read. */
  peek?: PeekOptions;
  /**
   * Follow at most this many redirects. 0 returns the redirect response itself, without asking where
   * it points, so the caller decides whether to go there.
   */
  maxRedirects?: number;
  method?: "GET" | "HEAD";
  /**
   * Read the body as bytes, kept as a string of one character per byte (latin1), for a file such as a
   * PDF that is not text. `maxBytes` then sets the size cap, up to DOCUMENT_HARD_CAP, rather than only
   * lowering the fetcher's; the body is cut there and the hop is flagged `truncated`. GET only: a
   * file is never sent anywhere, and the bytes are parsed in memory and dropped.
   */
  binary?: boolean;
  /** Send `headers` only to hops on the first address's origin: a redirect elsewhere gets none. */
  headersSameOrigin?: boolean;
  /**
   * Ask again even though this address was already asked in this run, and keep the new answer. For a
   * retry after "slow down": without it the fetcher would hand back the same refusal it remembers.
   */
  fresh?: boolean;
}

/** What `fetcher.query()` needs besides the address. */
export interface QueryOptions {
  /**
   * The id of a REGISTERED allowlist entry (`registerQueryAllow`, in an adapter's file). An id
   * nobody registered is refused: a caller cannot pass an entry of its own.
   */
  allow: string;
  /** For an entry whose host is `{ configured }`: the host from the adapter's validated configuration. */
  host?: string;
  /** The query as an object. It is serialised once; that text is what is checked and what is sent. */
  body: Record<string, unknown>;
  /**
   * For an mcp-jsonrpc entry (ADR-0008): the values the person configured, by setting name
   * ({ projectRef: "..." }). Each configured option in the address must equal its value exactly.
   */
  configured?: Readonly<Record<string, string>>;
  /** The key or token, from the environment. Sent to the entry's origin only; never logged. */
  headers?: Record<string, string>;
  /** Read at most this many bytes of the answer; it can only lower the fetcher's own cap. */
  maxBytes?: number;
}

export interface Fetcher {
  /** Every redirect hop; the last one is the final response. */
  get(url: string, opts?: GetOptions): Promise<Hop[]>;
  /**
   * The only way to send a POST (ADR-0006): a documented read-only query on an adapter's
   * registered allowlist, named by id. Refused with a QueryRefusedError, before anything is sent,
   * unless the id is registered, the address matches the entry (https, host, path) and the body is
   * a query of the entry's shape (a GraphQL `query`, or a JSON object of the entry's query keys and
   * operators, none named like a write). A redirect is never followed, so the body and headers go
   * to the entry's origin only: a 3xx is refused. The request is in `history()` with kind "query"
   * and the entry's id, never the body. Not remembered: every call is a request. Takes the same
   * slot, timeout and size cap as `get`.
   * Absent on a stand-in, like `history`; the real fetcher always has it.
   */
  query?(url: string, opts: QueryOptions): Promise<Hop>;
  /**
   * Fetch what someone typed. A bare domain ("example.com") is tried as https first and, if the
   * secure address does not answer at all, as http. The fallback is recorded on the first hop.
   */
  getSite(address: string, opts?: GetOptions): Promise<Hop[]>;
  readonly stats: { readonly requests: number; readonly maxInFlight: number };
  /**
   * Every request this fetcher sent or refused to send, in the order the answers came back: the
   * address, its kind, the status, the time. For the app's "Pages checked" view. Absent on a stand-in.
   */
  history?(): readonly RequestRecord[];
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

/** The first `maxBytes` of a body, then the stream is closed. Bytes that never arrive are not waited for. */
async function readPeek(
  body: Readable,
  peek: PeekOptions,
): Promise<{ label: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      const room = peek.maxBytes - size;
      chunks.push(buf.subarray(0, room));
      size += Math.min(buf.byteLength, room);
      if (size >= peek.maxBytes) {
        body.destroy();
        break;
      }
    }
  } catch (err) {
    // A body that ends early or fails keeps what arrived; a deadline is the caller's to report.
    if (isTimeout(err)) throw err;
  }
  const buf = Buffer.concat(chunks, size);
  return {
    label: peek.sniff(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)),
    bytes: size,
  };
}

/** The most a binary read may ask for, whatever the caller passes. */
export const DOCUMENT_HARD_CAP = 25 * 1024 * 1024;

async function readCapped(
  body: Readable,
  cap: number,
  contentType: string | undefined,
  unzip = true,
  binary = false,
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
  if (binary) return { body: buf.toString("latin1"), truncated, bytes: size };
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
  /** POST only from `fetcher.query()` (ADR-0006). */
  method: "GET" | "HEAD" | "POST";
  headers: Record<string, string>;
  /** The JSON text of a query; present only with POST. */
  body?: string;
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
/** Connection failures where another address of the same name may still answer. */
const UNREACHABLE: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  // No IPv6 on this machine at all: the IPv4 address may still answer.
  "EAFNOSUPPORT",
]);

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
  async function checkedAddresses(
    logical: URL,
    target: URL,
    mapped: boolean,
  ): Promise<ResolvedAddress[]> {
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
    return addresses;
  }
  return async (url, req) => {
    const target = route(url);
    const addresses = await checkedAddresses(url, target, target !== url);
    // Every address was checked above. Connect to the first; when it refuses the connection, the
    // next (localhost is ::1 first on macOS, while many dev servers listen on 127.0.0.1 only).
    let refused: unknown;
    for (const pinned of addresses) {
      try {
        options.onSend?.();
        return await send(target, { ...req, pinned, ...(options.ca ? { ca: options.ca } : {}) });
      } catch (err) {
        if (!UNREACHABLE.has(String((err as { code?: unknown }).code))) throw err;
        refused = err;
      }
    }
    throw refused;
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

  const history: RequestRecord[] = [];
  let chains = 0;

  /** Where a redirect points, as an absolute address; undefined when it does not make one. */
  function resolveLocation(from: string, location: string | null): string | undefined {
    if (location === null) return undefined;
    try {
      return new URL(location.trim(), from).href;
    } catch {
      return undefined;
    }
  }

  function errorOf(err: unknown): RequestError {
    if (err instanceof FetchError) {
      if (err.reason === "timeout") return "timeout";
      if (err.reason === "private-address-refused" || err.reason === "blocked-address")
        return "private-address-refused";
    }
    return "no-answer";
  }

  async function requestOnce(
    url: string,
    method: "GET" | "HEAD" | "POST",
    headers: Record<string, string>,
    at: { kind: RequestKind; chain: number; hop: number },
    extra: {
      anonymous?: boolean;
      peek?: PeekOptions;
      maxBytes?: number;
      binary?: boolean;
      /** A query that `query()` has already checked against an allowlist: the only way method is POST. */
      query?: { body: string; allow: string };
    } = {},
  ): Promise<{ hop: Hop; location: string | null }> {
    const query = extra.query;
    if (query === undefined) assertReadOnly(method);
    else if (method !== "POST") throw new TypeError("A query is sent with POST.");
    return gate.run(async () => {
      const started = performance.now();
      const note = (r: Pick<RequestRecord, "status" | "error" | "location">) => {
        const ms = Math.round(performance.now() - started);
        history.push({
          url,
          kind: query === undefined ? at.kind : "query",
          method,
          ...(query === undefined ? {} : { allow: query.allow }),
          status: r.status,
          ...(r.error ? { error: r.error } : {}),
          ms,
          ...(r.location ? { location: r.location } : {}),
          chain: at.chain,
          hop: at.hop,
        });
      };
      let res;
      const target = new URL(url);
      try {
        res = await transport(target, {
          method,
          headers: {
            "user-agent": userAgent,
            ...headers,
            // A query carries only the headers its caller gave: the per-address headers of a
            // protected preview belong to the checked site, never to a vendor's API.
            ...(extra.anonymous || query !== undefined ? {} : options.headersFor?.(target)),
          },
          ...(query === undefined ? {} : { body: query.body }),
          timeoutMs,
        });
      } catch (err) {
        options.onRequest?.({
          method,
          url,
          status: "error",
          ms: Math.round(performance.now() - started),
        });
        if (err instanceof FetchError) {
          note({ status: null, error: errorOf(err) });
          throw err;
        }
        const d = describeNetworkFailure(url, err, timeoutMs);
        const failure = new FetchError(d.reason, d.message, url, [], err, d.hint);
        note({ status: null, error: errorOf(failure) });
        throw failure;
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
      } else if (extra.peek) {
        try {
          const { label, bytes } = await readPeek(res.body, extra.peek);
          hop.peek = label;
          hop.bytes = bytes;
        } catch (err) {
          note({ status: null, error: "timeout" });
          throw new FetchError(
            "timeout",
            `${hostOf(url)} did not send the start of the file within ${timeoutMs / 1000} seconds.`,
            url,
            [],
            err,
          );
        }
      } else {
        try {
          const { body, truncated, bytes } = await readCapped(
            res.body,
            extra.binary
              ? Math.min(extra.maxBytes ?? LIMITS.documentBytes, DOCUMENT_HARD_CAP)
              : extra.maxBytes === undefined
                ? maxBodyBytes
                : Math.min(extra.maxBytes, maxBodyBytes),
            res.headers["content-type"],
            true,
            extra.binary === true,
          );
          hop.body = body;
          hop.bytes = bytes;
          if (truncated) hop.truncated = true;
        } catch (err) {
          note({ status: null, error: "timeout" });
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
      note({ status: hop.status, location: resolveLocation(url, location) });
      return { hop, location };
    });
  }

  async function follow(start: string, opts: GetOptions, kind: RequestKind): Promise<Hop[]> {
    const chain = chains++;
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
        step = await requestOnce(
          current,
          method,
          headers,
          { kind, chain, hop: hops.length },
          {
            ...(opts.anonymous ? { anonymous: true } : {}),
            ...(opts.peek ? { peek: opts.peek } : {}),
            ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
            ...(opts.binary && method === "GET" ? { binary: true } : {}),
          },
        );
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
      if (opts.maxRedirects !== undefined && hops.length > opts.maxRedirects) return hops;
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
    const key = `${method} ${normal}${opts.headers ? ` ${JSON.stringify(Object.entries(opts.headers).sort())}` : ""}${opts.headersSameOrigin ? " same-origin" : ""}${opts.anonymous ? " anonymous" : ""}${opts.binary ? " binary" : ""}${opts.peek ? ` peek:${opts.peek.maxBytes}` : ""}${opts.maxBytes === undefined ? "" : ` max:${opts.maxBytes}`}${opts.maxRedirects === undefined ? "" : ` redirects:${opts.maxRedirects}`}`;
    if (opts.fresh) memo.delete(key);
    let pending = memo.get(key);
    if (!pending) {
      pending = follow(normal, opts, currentKind());
      memo.set(key, pending);
    }
    return pending;
  }

  /**
   * Headers a caller of query() never sets: the fetcher sets its own, and these would change what
   * the request is (a method override), how its body is framed, who it is sent as, or how much of
   * the answer comes back.
   */
  const FORBIDDEN_QUERY_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "content-type",
    "content-encoding",
    "accept",
    "accept-encoding",
    "user-agent",
    "transfer-encoding",
    "te",
    "trailer",
    "expect",
    "upgrade",
    "cookie",
    "proxy-authorization",
    "range",
    "if-range",
  ]);
  /** Any header whose name speaks of a method (X-HTTP-Method-Override, X-Original-Method, ...). */
  const METHOD_HEADER = /method|override/i;

  async function query(url: string, opts: QueryOptions): Promise<Hop> {
    const id = typeof opts.allow === "string" ? opts.allow : "unknown";
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      // The text may hold a key: say nothing of it.
      throw new QueryRefusedError("an invalid address", id, "the address is not a valid URL");
    }
    const refuse = (reason: string): never => {
      throw new QueryRefusedError(target.host, id, reason);
    };
    const entry = resolveQueryAllow(opts.allow);
    if (entry === undefined) return refuse("no allowlist entry with this id is registered");
    // Serialise once: this text is validated (as parsed back) and is exactly what is sent.
    const body = serializeBody(opts.body);
    if (!body.ok) return refuse(body.reason);
    const why = queryRefusal(target, entry, body.parsed, opts.host, opts.configured);
    if (why !== undefined) return refuse(why);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      const lower = name.toLowerCase();
      if (FORBIDDEN_QUERY_HEADERS.has(lower) || METHOD_HEADER.test(lower))
        refuse(`the ${lower} header is set by the fetcher or would change the request`);
      headers[lower] = value;
    }
    const step = await requestOnce(
      target.href,
      "POST",
      {
        ...headers,
        // A remote MCP server may answer as JSON or as an event stream; the spec asks for both (ADR-0008).
        accept:
          entry.body.kind === "mcp-jsonrpc"
            ? "application/json, text/event-stream"
            : "application/json",
        "content-type": "application/json",
      },
      { kind: currentKind(), chain: chains++, hop: 0 },
      {
        query: { body: body.text, allow: entry.id },
        ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
      },
    ).catch((err: unknown) => {
      if (err instanceof FetchError)
        throw new FetchError(err.reason, err.message, err.url, [], err.cause, err.hint);
      throw err;
    });
    if (step.location !== null)
      throw new FetchError(
        "refused",
        `${target.host} answered a read-only query with a redirect (${step.hop.status}). Gaugeline does not send a query body anywhere else.`,
        target.href,
        [step.hop],
        undefined,
        "Use the address the vendor documents for this endpoint.",
      );
    return step.hop;
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
    query,
    history: () => history,
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
