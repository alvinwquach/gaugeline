/**
 * The one place the writer opens a connection (ADR-0010; named in the post-boundary scan's list and
 * exempted in the lint rules, and nowhere else): to https://api.github.com only, with the customer's
 * token in the Authorization header and nowhere else, after the registry has accepted the request.
 * Redirects are refused so the token cannot follow one to another host. The response body is returned to
 * the caller, which keeps the fields it needs and never logs it.
 *
 * It calls the global `fetch` directly, so the post-boundary scan sees the connection; a test replaces
 * the global.
 */
import { checkRequest, ENDPOINTS, type GithubRequest } from "./endpoints.js";

const API = "https://api.github.com";

export interface GithubResponse {
  status: number;
  json: unknown;
}

export type Send = (req: GithubRequest) => Promise<GithubResponse>;

/**
 * The address to fetch for a registered path: on api.github.com, and exactly the path the registry
 * checked. A path the URL parser would rewrite (a dot segment, a backslash, a tab) or move to another
 * host (`//host/...`) is refused, so what was checked is what is sent.
 */
export function apiUrl(path: string, query: Readonly<Record<string, string>> = {}): URL {
  const url = new URL(path, API);
  if (url.origin !== API) throw new Error("the writer talks to api.github.com only");
  if (url.pathname !== path) throw new Error("the writer sends the path it checked, unchanged");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

export function githubSender(token: string): Send {
  if (token.trim() === "") throw new Error("the writer needs the customer's GitHub token");
  return async (req) => {
    checkRequest(req);
    const url = apiUrl(req.path, req.query);
    const res = await fetch(url.href, {
      method: ENDPOINTS[req.endpoint].method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        ...(req.body ? { "content-type": "application/json" } : {}),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      redirect: "error",
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  };
}
