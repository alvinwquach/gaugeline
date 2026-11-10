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
  constructor(retry: string | undefined) {
    super(
      `The system asked Gaugeline to slow down (HTTP 429).${retry ? ` Try again ${retry}.` : " It did not say when to try again."}`,
    );
    this.name = "ConnectorRateLimitedError";
    this.retry = retry;
  }
}

/** "in 120 seconds" from a Retry-After in seconds, "after <date>" from a date or a reset time. */
export function describeRetry(headers: Record<string, string>): string | undefined {
  const after = (headers["retry-after"] ?? "").trim();
  if (/^\d{1,6}$/.test(after)) return `in ${after} second${after === "1" ? "" : "s"}`;
  const stamp = after !== "" ? after : (headers["ratelimit-resettime"] ?? "").trim();
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? undefined : `after ${new Date(ms).toISOString().replace(".000Z", "Z")}`;
}

export interface ConnectorRequest {
  /** The whole Authorization header value, e.g. "Bearer <key>". Sent to the first address's origin only. */
  authorization?: string;
  /** Other headers, such as a vendor's own key header. Sent to the first address's origin only too. */
  headers?: Record<string, string>;
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
  });
  const last = hops.at(-1);
  if (!last) throw new Error("No answer.");
  if (last.status === 401 || last.status === 403) throw new ConnectorRefusedError(last.status);
  if (last.status === 429) throw new ConnectorRateLimitedError(describeRetry(last.headers));
  if (last.status < 200 || last.status >= 300)
    throw new Error(`The system answered HTTP ${last.status}.`);
  return last;
}
