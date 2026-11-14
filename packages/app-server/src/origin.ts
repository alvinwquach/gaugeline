/**
 * The cross-site rules, checked before any route. Binding to 127.0.0.1 keeps the network out; these
 * keep out a page in another tab, which can ask the browser to call localhost, and DNS rebinding,
 * where a hostile name resolves to 127.0.0.1 and only the Host header gives it away.
 */
export type Refusal = "host" | "origin" | "fetch-site";

/** The two addresses the app answers to, exactly: no suffix, prefix or pattern matching. */
export function allowedHosts(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
}

const allowedOrigins = (port: number) => new Set([...allowedHosts(port)].map((h) => `http://${h}`));

export interface RequestFacts {
  method: string;
  /** The Host header; undefined when missing or sent more than once. */
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
}

/**
 * In order: Host must be one of the two; Origin, when sent, one of the two (never "null"); any
 * method but GET and HEAD must send one; Sec-Fetch-Site, when sent, same-origin or none.
 */
export function checkRequest(
  req: RequestFacts,
  port: number,
): { ok: true } | { ok: false; reason: Refusal } {
  if (req.host === undefined || !allowedHosts(port).has(req.host.toLowerCase()))
    return { ok: false, reason: "host" };
  const origins = allowedOrigins(port);
  if (req.origin !== undefined && !origins.has(req.origin.toLowerCase()))
    return { ok: false, reason: "origin" };
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && req.origin === undefined)
    return { ok: false, reason: "origin" };
  if (
    req.secFetchSite !== undefined &&
    req.secFetchSite !== "same-origin" &&
    req.secFetchSite !== "none"
  )
    return { ok: false, reason: "fetch-site" };
  return { ok: true };
}

/** What each refusal says: the rule, and nothing else. */
export const REFUSAL_TEXT: Readonly<Record<Refusal | "session", string>> = {
  host: "Refused: the Host header is not this app's address on this computer.\n",
  origin: "Refused: the request came from another website (its Origin).\n",
  "fetch-site": "Refused: the request came from another website (Sec-Fetch-Site).\n",
  session:
    "Refused: this needs the link printed in the terminal. It works once; to open the app again, restart gaugeline open.\n",
};
