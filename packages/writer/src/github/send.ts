/**
 * The one place the writer opens a connection: to https://api.github.com only, with the customer's token
 * in the Authorization header and nowhere else, after the registry has accepted the request. Redirects
 * are refused so the token cannot follow one to another host. The response body is returned to the
 * caller, which keeps the fields it needs and never logs it.
 */
import { checkRequest, ENDPOINTS, type GithubRequest } from "./endpoints.js";

const API = "https://api.github.com";

export interface GithubResponse {
  status: number;
  json: unknown;
}

export type Send = (req: GithubRequest) => Promise<GithubResponse>;

export function githubSender(token: string, fetchImpl: typeof fetch = globalThis.fetch): Send {
  if (token.trim() === "") throw new Error("the writer needs the customer's GitHub token");
  return async (req) => {
    checkRequest(req);
    const url = new URL(req.path, API);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    if (url.origin !== API) throw new Error("the writer talks to api.github.com only");
    const res = await fetchImpl(url.href, {
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
