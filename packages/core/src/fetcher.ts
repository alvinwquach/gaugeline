import { LIMITS } from "./limits.js";
import { Semaphore } from "./semaphore.js";

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
  /** Set on the first hop when https did not answer and http was used instead. */
  fallbackFrom?: string;
}

export type FetchErrorCode = "loop" | "too-many-redirects" | "timeout" | "network";

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly url: string;
  readonly hops: Hop[];
  constructor(code: FetchErrorCode, message: string, url: string, hops: Hop[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FetchError";
    this.code = code;
    this.url = url;
    this.hops = hops;
  }
}

export interface FetcherOptions {
  concurrency?: number;
  timeoutMs?: number;
  userAgent?: string;
  maxHops?: number;
  maxBodyBytes?: number;
}

export interface GetOptions {
  headers?: Record<string, string>;
  method?: "GET" | "HEAD";
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

/**
 * The memo key for an address: lowercase scheme and host (IDN hosts become punycode), no default
 * port, no fragment. The query and the trailing slash are kept as they are.
 */
export function normaliseUrl(input: string | URL): string {
  const url = new URL(typeof input === "string" ? input.trim() : input.href);
  url.hash = "";
  return url.href;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function readCapped(
  res: Response,
  cap: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > cap) {
        chunks.push(value.subarray(0, cap - size));
        size = cap;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (err) {
    // A body that ends early or fails to decompress keeps what arrived and is marked truncated.
    if (isTimeout(err)) throw err;
    truncated = true;
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { body: new TextDecoder("utf-8").decode(buf), truncated };
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

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const {
    concurrency = LIMITS.concurrency,
    timeoutMs = 10_000,
    userAgent = DEFAULT_USER_AGENT,
    maxHops = LIMITS.redirectHops,
    maxBodyBytes = LIMITS.bodyBytes,
  } = options;
  const gate = new Semaphore(concurrency);
  /** In-flight promises, so two checks asking at the same moment share one request. */
  const memo = new Map<string, Promise<Hop[]>>();
  let requests = 0;

  async function requestOnce(
    url: string,
    method: "GET" | "HEAD",
    headers: Record<string, string>,
  ): Promise<{ hop: Hop; location: string | null }> {
    assertReadOnly(method);
    return gate.run(async () => {
      requests += 1;
      const started = performance.now();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          redirect: "manual",
          headers: { "user-agent": userAgent, ...headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (isTimeout(err)) {
          throw new FetchError(
            "timeout",
            `${hostOf(url)} did not answer within ${timeoutMs / 1000} seconds.`,
            url,
            [],
            err,
          );
        }
        throw new FetchError("network", `${hostOf(url)} could not be reached.`, url, [], err);
      }
      const hop: Hop = { url, status: res.status, headers: headersToRecord(res.headers), ms: 0 };
      const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
      if (location !== null || method === "HEAD") {
        await res.body?.cancel().catch(() => undefined);
      } else {
        try {
          const { body, truncated } = await readCapped(res, maxBodyBytes);
          hop.body = body;
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
      return { hop, location };
    });
  }

  async function follow(start: string, opts: GetOptions): Promise<Hop[]> {
    const method = opts.method ?? "GET";
    assertReadOnly(method);
    const hops: Hop[] = [];
    const visited = new Set<string>();
    let current = start;
    for (;;) {
      visited.add(normaliseUrl(current));
      let step;
      try {
        step = await requestOnce(current, method, opts.headers ?? {});
      } catch (err) {
        if (err instanceof FetchError) {
          throw new FetchError(err.code, err.message, err.url, hops, err.cause);
        }
        throw err;
      }
      hops.push(step.hop);
      if (step.location === null) return hops;
      const next = new URL(step.location.trim(), current).href;
      if (visited.has(normaliseUrl(next))) {
        throw new FetchError("loop", `Redirect loop: ${next} was already visited.`, start, hops);
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
    const key = `${method} ${normal}${opts.headers ? ` ${JSON.stringify(Object.entries(opts.headers).sort())}` : ""}`;
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
        (err.code !== "network" && err.code !== "timeout")
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
