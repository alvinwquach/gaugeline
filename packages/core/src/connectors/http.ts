import type { Fetcher, Hop } from "../fetcher.js";

/** The system answered 401 or 403: it knows the key and will not let it read this. */
export class ConnectorRefusedError extends Error {
  readonly status: number;
  /** What to do about it, in the connector's own terms. Absent for the generic refusal. */
  readonly hint: string | undefined;
  constructor(status: number, hint?: string) {
    super(`The system refused the key (HTTP ${status}).${hint ? ` ${hint}` : ""}`);
    this.name = "ConnectorRefusedError";
    this.status = status;
    this.hint = hint;
  }
}

/**
 * The system answered 429: it will talk again later. `retry` says when, in the system's own terms
 * ("in 120 seconds", "after 2026-11-10T21:00:00Z"), read from Retry-After or, for Yelp,
 * RateLimit-ResetTime. It is undefined when the system did not say.
 */
export class ConnectorRateLimitedError extends Error {
  readonly retry: string | undefined;
  /** Retry-After as whole seconds, when the system sent it in that form (not as a date). */
  readonly retrySeconds: number | undefined;
  constructor(retry: string | undefined, retrySeconds?: number) {
    super(
      `The system asked Gaugeline to slow down (HTTP 429).${retry ? ` Try again ${retry}.` : " It did not say when to try again."}`,
    );
    this.name = "ConnectorRateLimitedError";
    this.retry = retry;
    this.retrySeconds = retrySeconds;
  }
}

/** Any answer that is not a 2xx, 401, 403 or 429. The message names the status and nothing from the body. */
export class ConnectorStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The system answered HTTP ${status}.`);
    this.name = "ConnectorStatusError";
    this.status = status;
  }
}

/** "in 120 seconds" from a Retry-After in seconds, "after <date>" from a date or a reset time. */
export function describeRetry(headers: Record<string, string>): string | undefined {
  const after = (headers["retry-after"] ?? "").trim();
  const seconds = retryAfterSeconds(headers);
  if (seconds !== undefined) return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
  // Anything else made of digits and points is a malformed number of seconds, never a date.
  if (/^[\d.]+$/.test(after)) return undefined;
  const stamp = after !== "" ? after : (headers["ratelimit-resettime"] ?? "").trim();
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? undefined : `after ${new Date(ms).toISOString().replace(".000Z", "Z")}`;
}

/**
 * Retry-After as whole seconds, or undefined (absent, a date, or anything else). A decimal such as
 * "2.0" (Shopify sends one) is seconds too, rounded up so a wait is never too short.
 */
export function retryAfterSeconds(headers: Record<string, string>): number | undefined {
  // Contentful names its wait X-Contentful-RateLimit-Reset (whole seconds) and sends no Retry-After.
  const after = (headers["retry-after"] ?? headers["x-contentful-ratelimit-reset"] ?? "").trim();
  return /^\d{1,6}(?:\.\d{1,3})?$/.test(after) ? Math.ceil(Number(after)) : undefined;
}

export interface ConnectorRequest {
  /** The whole Authorization header value, e.g. "Bearer <key>". Sent to the first address's origin only. */
  authorization?: string;
  /** Other headers, such as a vendor's own key header. Sent to the first address's origin only too. */
  headers?: Record<string, string>;
  /** Ask again even if this address was already asked in this run (a retry; the fetcher remembers answers). */
  fresh?: boolean;
  /** Send nothing the fetcher adds per address (a protected preview's headers): a visitor with no session. */
  anonymous?: boolean;
  /**
   * Follow at most this many redirects. 0: none, and a 3xx answer is thrown as ConnectorStatusError, so a key sent in a
   * header goes nowhere but the address that was asked (a draft read with a Preview API key, for one).
   */
  maxRedirects?: number;
}

/**
 * The one way a connector asks its system a question: a GET through the fetcher, with the key in a
 * per-request Authorization header and never in the address. A redirect to another origin is
 * followed without the header. Returns the final response when it is a 2xx; a 401 or 403 throws
 * ConnectorRefusedError, a 429 ConnectorRateLimitedError (with when to retry), any other status an
 * Error that names the status and nothing from the body.
 */
export async function connectorGet(
  fetcher: Fetcher,
  url: string,
  request: ConnectorRequest,
): Promise<Hop> {
  const extra = Object.entries(request.headers ?? {}).filter(
    ([name]) => name.toLowerCase() !== "authorization",
  );
  const hops = await fetcher.get(url, {
    headers: {
      ...Object.fromEntries(extra),
      ...(request.authorization !== undefined ? { authorization: request.authorization } : {}),
    },
    headersSameOrigin: true,
    ...(request.fresh === true ? { fresh: true } : {}),
    ...(request.anonymous === true ? { anonymous: true } : {}),
    ...(request.maxRedirects !== undefined ? { maxRedirects: request.maxRedirects } : {}),
  });
  const last = hops.at(-1);
  if (!last) throw new Error("No answer.");
  if (last.status === 401 || last.status === 403) throw new ConnectorRefusedError(last.status);
  if (last.status === 429)
    throw new ConnectorRateLimitedError(
      describeRetry(last.headers),
      retryAfterSeconds(last.headers),
    );
  if (last.status < 200 || last.status >= 300) throw new ConnectorStatusError(last.status);
  return last;
}
