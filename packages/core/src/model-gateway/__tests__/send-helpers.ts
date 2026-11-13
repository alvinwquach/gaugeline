import { EventEmitter } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestFn } from "../send.js";

export interface Seen {
  url: URL;
  options: RequestOptions;
}

/** A local server on a loopback address. Only a test does this: the sender itself never reaches one. */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push(body);
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A request function that records what the sender asked for (the https address, the method, the headers) and
 * carries it out against a local server instead: the real client request and response objects, no TLS and no DNS.
 */
export function routeTo(port: number): { request: RequestFn; seen: Seen[] } {
  const seen: Seen[] = [];
  const request: RequestFn = (url, options, cb) => {
    seen.push({ url, options });
    // A plain http request cannot take the https agent or the lookup; the lookup is tested on its own and on the real path.
    const { lookup: _lookup, agent: _agent, ...rest } = options;
    return httpRequest({ ...rest, host: "127.0.0.1", port, path: url.pathname + url.search }, cb);
  };
  return { request, seen };
}

/** A client request that never answers, and counts what was done to it. */
export function hangingRequest(): { request: RequestFn; seen: Seen[]; destroyed: () => number } {
  const seen: Seen[] = [];
  let destroyed = 0;
  const request: RequestFn = (url, options) => {
    seen.push({ url, options });
    const req = new EventEmitter() as EventEmitter & {
      end(): void;
      destroy(): void;
      write(): void;
    };
    req.end = () => undefined;
    req.write = () => undefined;
    req.destroy = () => {
      destroyed += 1;
    };
    return req as never;
  };
  return { request, seen, destroyed: () => destroyed };
}
