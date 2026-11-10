import type { Fetcher, Hop } from "../fetcher.js";

/** The system answered 401 or 403: it knows the key and will not let it read this. */
export class ConnectorRefusedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The system refused the key (HTTP ${status}).`);
    this.name = "ConnectorRefusedError";
    this.status = status;
  }
}

export interface ConnectorRequest {
  /** The whole Authorization header value, e.g. "Bearer <key>". Sent to the first address's origin only. */
  authorization: string;
  headers?: Record<string, string>;
}

/**
 * The one way a connector asks its system a question: a GET through the fetcher, with the key in a
 * per-request Authorization header and never in the address. A redirect to another origin is
 * followed without the header. Returns the final response when it is a 2xx; a 401 or 403 throws
 * ConnectorRefusedError, any other status an Error that names the status and nothing from the body.
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
    headers: { ...Object.fromEntries(extra), authorization: request.authorization },
    headersSameOrigin: true,
  });
  const last = hops.at(-1);
  if (!last) throw new Error("No answer.");
  if (last.status === 401 || last.status === 403) throw new ConnectorRefusedError(last.status);
  if (last.status < 200 || last.status >= 300)
    throw new Error(`The system answered HTTP ${last.status}.`);
  return last;
}
