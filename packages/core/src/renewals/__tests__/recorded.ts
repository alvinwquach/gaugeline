import { Readable } from "node:stream";
import type { Transport } from "../../fetcher.js";
import type { Certificate } from "../../dns/certificate.js";

export interface Recorded {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  certificate?: Certificate;
  /** Throw this instead of answering. */
  fail?: Error;
}

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * A transport that answers from recorded (invented) responses by "METHOD url" and notes every request.
 * Nothing touches the network. An unrecorded request is a 404, so a test sees what was asked.
 */
export function recordedTransport(routes: Record<string, Recorded>): {
  transport: Transport;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const hit = routes[`${req.method} ${url.href}`] ?? routes[`GET ${url.href}`];
    if (hit?.fail) return Promise.reject(hit.fail);
    const body =
      hit?.body === undefined
        ? ""
        : typeof hit.body === "string"
          ? hit.body
          : JSON.stringify(hit.body);
    return Promise.resolve({
      status: hit?.status ?? 404,
      headers: { "content-type": "application/json", ...hit?.headers },
      body: Readable.from(req.method === "HEAD" ? [] : [Buffer.from(body)]),
      ...(hit?.certificate ? { certificate: hit.certificate } : {}),
    });
  };
  return { transport, seen };
}

/** An invented key built at run time so no key-shaped string sits in the repository. */
export const fakeKey = (...parts: string[]): string => parts.join("");
