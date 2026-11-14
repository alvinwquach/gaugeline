/**
 * The writer's second connection (ADR-0010; named in the post-boundary scan's list and exempted in the
 * lint rules, and nowhere else): to `https://<project>.api.sanity.io` only, for the one project in the
 * customer's settings, with the customer's token in the Authorization header and nowhere else, after the
 * registry has accepted the request. Redirects are refused so the token cannot follow one to another host.
 * The response is returned parsed; a body that is not JSON, or is over 2 MB, is null. Nothing in it is ever
 * put in an error or a log. A failed connection throws a fixed message: fetch's own error can name the
 * address, and it must not carry anything the request held.
 *
 * It calls the global `fetch` directly, so the post-boundary scan sees the connection; a test replaces the
 * global.
 */
import {
  checkSanityRequest,
  isSanityTarget,
  SANITY_ENDPOINTS,
  type SanityRequest,
  type SanityTarget,
} from "./endpoints.js";

export interface SanityResponse {
  status: number;
  json: unknown;
}

export type SanitySend = (req: SanityRequest) => Promise<SanityResponse>;

export interface SanitySenderConfig extends SanityTarget {
  /** The customer's own token, from the worker's environment. Never from a payload. */
  token: string;
}

/** The longest response body read. A live document is far smaller; a larger one is treated as no answer. */
const MAX_RESPONSE_CHARS = 2_000_000;
/** A request that has not answered in this long is given up. */
const TIMEOUT_MS = 30_000;

/**
 * The address to fetch for a registered path: on the project's own host, https, and exactly the path the
 * registry checked. A path the URL parser would rewrite (a dot segment, a backslash, a tab, a query) or move
 * to another host (`//host/...`) is refused, so what was checked is what is sent.
 */
export function sanityUrl(
  target: SanityTarget,
  path: string,
  query: Readonly<Record<string, string>> = {},
): URL {
  const origin = `https://${target.projectId}.api.sanity.io`;
  const url = new URL(path, origin);
  if (url.origin !== origin)
    throw new Error(`the writer talks to ${target.projectId}.api.sanity.io only`);
  if (url.pathname !== path || url.search !== "" || url.hash !== "")
    throw new Error("the writer sends the path it checked, unchanged");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

export function sanitySender(config: SanitySenderConfig): SanitySend {
  const { token, ...target } = config;
  if (typeof token !== "string" || token.trim() === "")
    throw new Error("the writer needs the customer's Sanity token");
  if (!isSanityTarget(target))
    throw new Error("the Sanity project, dataset or API version is not plain names");
  return async (req) => {
    checkSanityRequest(req, target);
    const url = sanityUrl(target, req.path, req.query);
    let res: Response;
    try {
      res = await fetch(url.href, {
        method: SANITY_ENDPOINTS[req.endpoint].method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(req.body ? { "content-type": "application/json" } : {}),
        },
        body: req.body ? JSON.stringify(req.body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error("the request to Sanity failed");
    }
    let json: unknown = null;
    try {
      const text = await res.text();
      json = text.length > MAX_RESPONSE_CHARS ? null : (JSON.parse(text) as unknown);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}
