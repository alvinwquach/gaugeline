import { Readable } from "node:stream";
import { useCassette } from "../../../../testkit/src/index.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";

/** One request as the transport saw it. The transport type has no body: nothing here can carry one. */
export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetcher that answers from a recorded cassette and logs every request it receives. */
export function recorded(cassette: string, seen: Seen[] = []): Fetcher {
  const replay = useCassette(cassette, { mode: "replay" });
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    return replay(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

/** A fetcher whose network is one function: for the answers a cassette cannot hold. */
export function serving(answer: (url: URL, seen: Seen[]) => Answer, seen: Seen[] = []): Fetcher {
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const { status, body, headers } = answer(url, seen);
    return Promise.resolve({
      status,
      headers: { "content-type": "application/json", ...headers },
      body: Readable.from([
        Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {})),
      ]),
    });
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

export const lowerHeaders = (h: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
